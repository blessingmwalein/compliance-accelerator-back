---
name: reports-and-documents
description: Use when generating PDFs or other documents on the server (executive PDF, assessment/RoPA/DPO reports, training certificates), designing ReportDefinitions, stored report records, chart rendering for documents, fonts, footers or report permissions in fca-backend.
---

# Reports and documents (backend, normative)

## When to use
Any feature that produces a downloadable document or a stored report record. The legacy app generated PDFs in the browser with jsPDF/html2canvas from unscoped client-side data; that approach is **rejected** (unauthorised data exposure, no audit trail, numbers that drift from the dashboard, broken glyphs, unescaped HTML in certificates).

## Rules

### Architecture (decided in ADR-0008)
1. **Server-side only**, from authorised, organisation-scoped data, using **pdfmake 0.3** (declarative document definitions; no headless browser: serverless-hostile, large attack surface). One `ReportDefinition` per template in `src/reports/definitions/<name>.ts`: `{ id, version, title, requiredPermission, paramsSchema, loadData(ctx, params), build(data, params) }`. Data loading reuses the **same services/queries as the API** so a report can never disagree with the screen.
2. **Charts are server-rendered SVG** produced from the same DTOs (small pure helpers in `src/reports/charts/`: bar, radar, heatmap grid) and embedded as SVG; no screenshots of the UI.
3. **Fonts**: embed an OFL font family with full Latin coverage (e.g. Noto Sans / Inter) in `assets/fonts`. Do not rely on built-in PDF fonts: glyphs such as ✓ and → broke the legacy output. Test every template with accented names and the symbols used.
4. A report is a **stored record** (`reports` table, tenant-scoped): `id`, `template_id`, `template_version`, `params` (date range, framework filter, sections), `requested_by`, `status` (`queued|running|succeeded|failed`), `methodology_versions`, `framework_versions`, `data_snapshot` (JSONB of the inputs actually rendered), `storage_key`, `sha256`, `byte_size`, timestamps. The snapshot makes a re-render reproducible and explains any later difference to the live dashboard.
5. **Async by default**: `POST …/reports` returns `202` with the record; a job (see `notifications-and-jobs`) renders and stores it; the client polls `GET …/reports/:id` and downloads via an authorised proxied stream (`Content-Disposition: attachment`, `nosniff`). Small synchronous exports (single-record PDFs) may stream directly but still create the record.
6. **Permissions**: generating needs `reports.export` (or the module's own export permission); viewing history needs `reports.view`. Generation and every download are **audited**. Reports never include data the requester could not read through the API.
7. Evidence/Report **cores** exist from Phase 5 (one template, the storage abstraction, the record); the catalogue, history UI and remaining templates arrive in Phase 9a.

### Content rules
- **Cover and header**: organisation name (or product name), report title, period/scope, generated-by and generated-at **in the organisation timezone**. **Contents page** that cannot overflow (paginate it). **Continuation-page headers** and `Page X of N`.
- **Footer** (every page): `Generated <date> · Report <id> · Methodology <ids/versions> · Framework versions <…>` and the disclaimer: *"Informative aid; not legal advice. Mappings do not establish legal equivalence."* Confidentiality marking configurable (`CONFIDENTIAL — DPO Report` for the DPO pack).
- **Date filters apply consistently**: a record is included if it is *open/active during the period*, not only if its single date field falls inside it (the legacy DPO report hid stale-but-open records and ignored the window for retention). State the inclusion rule in the report.
- Missing data is shown as "Not assessed" / "No records", never as 0 or "Compliant". Truncation is never silent: tables paginate or say "N more rows omitted (see the register)".
- **AI-generated sections** (when included) are visually separated, labelled advisory, and show model/provider, time and sources considered.
- Accessibility: set document language, title and author metadata; use real text (no text-in-images); logical reading order; sufficient contrast.

### Catalogue (from the legacy app, to be rebuilt)
Executive summary PDF (Dashboard), Compliance Status, RoPA (landscape), Governance Assessment, Maturity & Gap, Consolidated DPO Report (cover, contents, up to seven optional sections: governance, RoPA, risks, lawful basis, DSARs, breaches, retention; date presets 30 days / 6 months / this year / all time), Training Certificate. Details: `docs/reference/legacy-findings.md` (A.8).

### Certificates
Generated server-side on quiz success (Phase 9b): stored `certificates` record with a random, non-guessable id (a public verification page may be added later), learner name and course title **escaped/handled as text** (never interpolated into HTML), issue date, score, organisation, signature line; PDF stored like any report. The legacy generator injected unescaped names into `innerHTML`.

## Example

```ts
export const ropaReport: ReportDefinition<RopaReportParams, RopaReportData> = {
  id: 'ropa', version: 1, requiredPermission: 'data.export',
  paramsSchema: RopaReportParamsDto,
  loadData: (ctx, p) => ctx.ropa.listForReport(p),               // same service the API uses
  build: (data, p) => ({
    pageOrientation: 'landscape',
    info: { title: 'Record of Processing Activities', author: data.organisation.name },
    header: continuationHeader(data), footer: standardFooter(data),
    content: [cover(data, p), contents(), section('Processing activities', ropaTable(data.rows)), disclaimer()],
  }),
};
```

## Anti-patterns
- Browser-side PDF generation; computing numbers in the report that differ from the API; reading data without the organisation scope.
- Built-in PDF fonts with symbols outside WinAnsi; unescaped user text in HTML/PDF markup; silent truncation; contents lists that overflow the page.
- Reports without a stored record/snapshot/checksum; unaudited downloads; public (unauthenticated) report URLs.
- Putting AI output inside a report without labelling it advisory.

## Checklist
- [ ] `ReportDefinition` uses the same services as the API; permission and audit wired
- [ ] Stored record has params, versions, snapshot, storage key, sha256
- [ ] Fonts embedded; accented and symbol text verified; metadata set
- [ ] Cover, contents, continuation header, footer with disclaimer and versions
- [ ] Period/inclusion rule stated; missing data shown as "Not assessed"/"No records"
- [ ] Async via jobs with progress/failure states; download proxied and audited
- [ ] Test renders the template with empty, small and large datasets

## References
ADR-0008, `notifications-and-jobs`, `security-and-rbac` (uploads/downloads), `grc-domain`, frontend `reports-and-documents`, `docs/reference/legacy-findings.md`.
