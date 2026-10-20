---
name: reports-and-documents
description: Use when generating PDFs or other documents on the server (executive PDF, assessment/RoPA/DPO reports, training certificates), designing ReportDefinitions, stored report records, chart rendering for documents, fonts, footers or report permissions in fca-backend.
---

# Reports and documents (backend, normative)

## When to use
Any feature that produces a downloadable document or a stored report record. The legacy app generated PDFs in the browser with jsPDF/html2canvas from unscoped client-side data; that approach is **rejected** (unauthorised data exposure, no audit trail, numbers that drift from the dashboard, broken glyphs, unescaped HTML in certificates).

## Rules

### Architecture (decided in ADR-0008, built in Phases 5, 8 and 9a)
1. **Server-side only**, from authorised, organisation-scoped data, using **pdfmake 0.3** (declarative document definitions; no headless browser: serverless-hostile, large attack surface). One template file per document in `src/reports/definitions/<name>.ts`: a `ReportTemplateDefinition` (`{ id, version, title, description, generate, params }`, where `params` describes each parameter's `type`/`required`/`values`/`default` so the form is generated from the definition) plus a pure `build…(data): PdfDocument`. The definitions are collected in `definitions/registry.ts` (`REPORT_TEMPLATES`, `templateOf`, `PLANNED_REPORT_TEMPLATES`) and that registry is the **only** source of the catalogue the API serves — the catalogue and the routes can never disagree. Data loading lives in the service, not the definition, and reuses the **same services the screens call** (`DashboardModule`, `RisksModule`, `RopaModule`, … export their service for exactly this reason) so a report can never disagree with the API.
2. **Charts are server-rendered SVG** produced from the same DTOs (small pure helpers in `src/reports/charts/`: bar, radar, heatmap grid) and embedded as SVG; no screenshots of the UI.
3. **Fonts**: embed an OFL font family with full Latin coverage (e.g. Noto Sans / Inter) in `assets/fonts`. Do not rely on built-in PDF fonts: glyphs such as ✓ and → broke the legacy output. Test every template with accented names and the symbols used. `src/reports/glyphs.ts` checks a document's strings against the font's coverage, so a new symbol fails loudly instead of printing a box.
4. A report is a **stored record** (`reports` table, tenant-scoped): `id`, `template`, `template_version`, `params` (the DTO exactly as sent), `assessment_id` (null for an organisation-wide document), `requested_by_user_id`, `status` (`PENDING | READY | FAILED`), `data_snapshot` (JSONB of the inputs actually rendered), `storage_key`, `sha256`, `size`, `created_at`, `finished_at`, `error_code`, `error_detail`, `updated_at`. The byte columns are null until the render finishes; a database check keeps that honest (`READY` ⇒ bytes and snapshot, `FAILED` ⇒ a code and `finished_at`). The snapshot makes a re-render reproducible and explains any later difference to the live dashboard.
5. **`generate` is declared per template.** `sync` renders in the request and answers `201` with a `READY` record — only for a document whose data one request can honestly carry (the two single-payload templates). Everything else is `async`: the route answers `202` with the `PENDING` record after enqueuing `report.generate` in the same transaction, the handler renders and stores through the `StorageProvider`, and `GET …/reports/{id}` is the poll. A non-`READY` report cannot be downloaded: `409` with the reason. `markReady`/`markFailed` are guarded on `status = 'PENDING'`, so a second runner cannot rewrite a finished record; when the guard fails the orphan bytes are deleted.
6. **Permissions**: generating needs `reports.export`, history and download need `reports.view`, and both keys come from `REPORT_PERMISSIONS` in `definitions/registry.ts` — the controller decorators and the catalogue read the same constant, so a permission cannot drift between what the API enforces and what it advertises. Generation, readiness, failure and every download are **audited** (`report.requested`, `report.generated`, `report.ready`, `report.failed`, `report.downloaded`). Reports never include data the requester could not read through the API.
7. **Bounded reads, stated truncation.** A multi-register document paginates through the list endpoints (`PAGE_SIZE` rows per call, a scan cap, and at most `MAX_PRINTED_ROWS` rows per section) and prints `notPrinted` plus "the register holds more records than this document reads" — a report that silently stops at row 60 is worse than one that says it did. New cross-register documents read through the existing list endpoints; they do not add report-only query filters or raw SQL.

### Content rules
- **Cover and header**: organisation name (or product name), report title, period/scope, generated-by and generated-at **in the organisation timezone**. **Contents page** that cannot overflow (paginate it). **Continuation-page headers** and `Page X of N`.
- **Footer** (every page): `Generated <date> · Report <id> · Methodology <ids/versions> · Framework versions <…>` and the disclaimer: *"Informative aid; not legal advice. Mappings do not establish legal equivalence."* Confidentiality marking configurable (`CONFIDENTIAL — DPO Report` for the DPO pack).
- **Date filters apply consistently**: a record is included if it is *open/active during the period*, not only if its single date field falls inside it (the legacy DPO report hid stale-but-open records and ignored the window for retention). State the inclusion rule in the report.
- Missing data is shown as "Not assessed" / "No records", never as 0 or "Compliant". Truncation is never silent: tables paginate or say "N more rows omitted (see the register)".
- **AI-generated sections** (when included) are visually separated, labelled advisory, and show model/provider, time and sources considered.
- Accessibility: set document language, title and author metadata; use real text (no text-in-images); logical reading order; sufficient contrast.

### Catalogue
Built: **Governance Assessment** (`governance_assessment`, one cycle, optional unit and framework filters, `sync`), **Executive Dashboard** (`executive_dashboard`, the whole organisation as of the day it is drawn, `sync`, no body), **Consolidated DPO Report** (`consolidated_dpo`, `async`: cover, contents, seven sections — governance, RoPA, risks, lawful basis, DSARs, breaches, retention — with the period presets `last_30_days` / `last_6_months` / `this_year` / `all` and an optional `confidential` marking of `CONFIDENTIAL — DPO Report`). Planned and served by the same catalogue so the screen can say "coming" truthfully: Training Certificate (9b), AI Risk Assessment (Phase 10). The legacy RoPA/Compliance Status/Maturity & Gap documents are covered by the assessment, dashboard and DPO pack rather than rebuilt as separate templates. Details: `docs/reference/legacy-findings.md` (A.8).

A document that leaves the organisation gets a **privacy shape**: the DPO pack prints no data-subject names or contact details (the requester's own register does, `users.view` does not reach a Compliance Manager), and it says so in the section that omits them.


### Certificates
Generated server-side on quiz success (Phase 9b): stored `certificates` record with a random, non-guessable id (a public verification page may be added later), learner name and course title **escaped/handled as text** (never interpolated into HTML), issue date, score, organisation, signature line; PDF stored like any report. The legacy generator injected unescaped names into `innerHTML`.

## Example

```ts
// src/reports/definitions/consolidated-dpo.ts — the definition and the builder, nothing else
export const consolidatedDpo = {
  id: 'consolidated_dpo',
  version: 1,
  title: 'Consolidated DPO Report',
  description: 'One document for the data-protection officer: ...',
  generate: 'async',
  params: [
    { name: 'period', type: 'enum', required: false, values: DPO_PERIODS, default: 'last_30_days', description: '...' },
    { name: 'confidential', type: 'boolean', required: false, description: '...' },
  ],
} as const satisfies ReportTemplateDefinition;

/** Pure: everything it prints is already in `data`, so the bytes depend only on the stored snapshot. */
export const buildConsolidatedDpo = (data: ConsolidatedDpoData): PdfDocument => ({ ... });

// registry.ts collects it; the service loads the rows through the register services the screens use.
export const REPORT_TEMPLATES = [governanceAssessment, executiveDashboard, consolidatedDpo] as const;
```

## Anti-patterns
- Browser-side PDF generation; computing numbers in the report that differ from the API; reading data without the organisation scope.
- A template that runs its own `findMany` or raw SQL instead of calling the register service the screen calls — two definitions of one count is how a report starts disagreeing with a dashboard.
- A catalogue built by hand in the controller or in the frontend: the registry entry is the catalogue.
- Built-in PDF fonts with symbols outside WinAnsi; unescaped user text in HTML/PDF markup; silent truncation; contents lists that overflow the page.
- Reports without a stored record/snapshot/checksum; unaudited downloads; public (unauthenticated) report URLs.
- Putting AI output inside a report without labelling it advisory.

## Checklist
- [ ] Template is in `definitions/registry.ts`, so `GET …/reports/catalogue` advertises it with the same params the route validates
- [ ] Loads through the services the API uses; permission (`REPORT_PERMISSIONS`) and audit wired
- [ ] Stored record has params, `templateVersion`, snapshot, storage key, sha256, size; `markReady`/`markFailed` guarded on `PENDING`
- [ ] Fonts embedded; accented and symbol text verified (`glyphs.ts`); metadata set
- [ ] Cover, contents, continuation header, footer with disclaimer and versions
- [ ] Period/inclusion rule stated; missing data shown as "Not assessed"/"No records"; truncation counted and named
- [ ] `sync` only when one request can carry it; otherwise `202` + `report.generate`, poll on `GET …/reports/{id}`, download refused until `READY`
- [ ] Rendered with empty, small and large datasets, and with a register over the scan cap

## References
ADR-0008, `notifications-and-jobs`, `security-and-rbac` (uploads/downloads), `grc-domain`, frontend `reports-and-documents`, `docs/reference/legacy-findings.md`.
