---
name: compliance-frameworks
description: Use when modelling, seeding, importing, versioning or mapping framework content (CDPA, POPIA, GDPR, BDPA, ISO 27701, NIST CSF), building Load Default Mappings, quick-start templates, deadline policies, or writing any statement about what a law requires in fca-backend.
---

# Compliance frameworks (backend, normative)

## When to use
Any time framework content, a mapping, a template, a legal deadline or a statement of "what the law says" enters the system or its copy. **Never fabricate legal obligations**, never imply the software guarantees compliance, and never load content that lacks provenance.

## Rules

### Content model (global reference data; organisation layer on top)
```
framework ──< framework_version ──< requirement (tree: parent_id, ref, title, text_source)
                     └──< mapping_pack_entry (from_requirement, to_requirement, relationship, provenance)
organisation_framework (organisation, framework_version in use, applicable_since)
organisation_mapping   (organisation, from/to requirement, relationship, origin: seed|user,
                        source_entry_id NULL, rationale, reference, review_status, UNIQUE(org, source_entry_id))
```
- `framework`: `code` (`CDPA|POPIA|GDPR|BDPA|ISO27701|NISTCSF`), name, jurisdiction, authority. **Do not hard-code the framework list anywhere else**: the legacy app omitted BDPA and NIST in many places; the API serves frameworks.
- `framework_version`: `label` (e.g. `GDPR (EU) 2016/679`, `ISO/IEC 27701:2019`, `ISO/IEC 27701:2025`, `NIST CSF 2.0`), `effective_from`, `status` **draft → verified → published → superseded**, `licence_class` (`public_domain|open_reuse|licensed_text|user_supplied`), provenance (`source_url`, `citation`, `retrieved_at`, `verified_by`, `verified_at`, `content_hash`). **Published versions are immutable.** Both ISO 27701 editions must be representable (2019 and the standalone 2025 edition, published 14 Oct 2025 per certification-body sources; confirm against the ISO catalogue).
- `requirement.text_source`: `verbatim | paraphrase | reference_only`. Store only what the licence permits: **ISO standard text is paid and copyrighted → identifiers/titles only or `user_supplied` by a licensed customer**; NIST CSF is public domain (US government) and may be ingested from NIST's published data; EUR-Lex text may be reused with attribution; national statutes need the **gazetted/official text** and a verifier.
- Assessments and mappings **pin a requirement (hence a version)** so history stays reproducible after a framework updates. Changing an organisation's selected frameworks never deletes assessments.

### Seeding and the "no invented content" gate
- Seed packs live in `prisma/seed-data/<framework>/<version>/*.json`, validated by a JSON schema that **requires provenance** and `status`. The loader **rejects anything not `verified`** and CI enforces it. An empty pack is valid; a fabricated one is not.
- Realistic Phase 4 content: **NIST CSF 2.0 Core** and **GDPR** (from EUR-Lex), ingested with provenance and a human verification step. **CDPA, POPIA and BDPA only after the owner supplies or approves the official/gazetted text** (and confirms which Botswana instrument is meant: the reference says "Botswana Data Protection Act, 2018"). **ISO 27701** ships as a `user_supplied` shell. No cross-framework mapping ships without a **cited crosswalk or a named legal reviewer**; otherwise `Load Default Mappings` reports that no verified data exists.
- Quick-start governance-area templates (CDPA/POPIA/GDPR/BDPA/ISO27701 packs) are subject to the same rule. The legacy template area names (e.g. "Breach Notification (72h)") are **unverified**, are not seed data, and must not carry default maturity values.

### What is built (Phase 4, 2026-10-16)
Tables `framework_versions`, `requirements`, `mapping_pack_entries` (global; frozen after verification by triggers; the app role has SELECT only) and `governance_areas`, `organisation_mappings` (tenant, RLS). Tooling in `scripts/frameworks/`: `extract` (parse a stored primary source into a DRAFT pack), `verify` (a named person), `load` (verified packs only, hash-checked), `status`. Extracted drafts: NIST CSF 2.0 (134 requirements from the Reference Tool export, withdrawn CSF 1.1 items excluded) and the GDPR (11 chapters + 99 article headings from the Official Journal); **neither is verified or loaded**; CDPA, POPIA, BDPA and ISO 27701 have no pack; no pack has mapping entries. Differences from the sketch below: statuses in the database are normally VERIFIED (a draft is never loaded); the pack file, not the database, carries the draft state; `organisation_framework` stayed the Phase 3 table (it points at the framework, not a version: versions are chosen by `currentVersion`, newest verified first). Mappings are filed under an optional organisation-owned `governance_area`.

### "Load Default Mappings" contract (Phase 4)
`POST /organisations/:id/compliance-mappings/load-defaults`: single transaction; considers only the organisation's selected framework versions; `INSERT … ON CONFLICT DO NOTHING RETURNING`; **never overwrites or deletes user rows**; returns `{ inserted, skipped[], failed[{ reason }] }`; records who initiated it (audit); safe to retry after partial failure. If no verified pack exists for the selection: **`422 SEED_DATA_UNAVAILABLE` with zero writes** and an explanatory `detail`. Pack upgrades are a separate diff-and-confirm flow. User mappings require `mapping.edit`, a mandatory `rationale`, and are audited; seed entries are never mutated.

### Wording
Every mapping surface says: *"Cross-framework mappings are informative and do not establish legal equivalence."* Relationships are `exact | partial | related`. Do not present a mapping as a legal opinion.

### Deadline policies (data, not code)
`deadline_policies`: `framework_version_id` (nullable), `kind` (`dsar_response`, `dsar_extension`, `breach_regulator_notice`, `breach_subject_notice`), `days/hours`, `extension_allowed`, `source_citation`, `verified_by/at`, `status`. Default **Not configured**. Candidate values below are **unverified leads, not rules**; do not enable any without a primary-source check and a verifier.

### Source registry (`docs/frameworks/source-registry.md`; every entry starts `verified: false`)
| Framework | Candidate authoritative source (to verify) | Notes |
|---|---|---|
| GDPR | EUR-Lex: Regulation (EU) 2016/679 (`https://eur-lex.europa.eu/eli/reg/2016/679/oj`) | Reuse with attribution; DSAR one month (Art. 12(3)) is a lead to verify |
| POPIA | Protection of Personal Information Act 4 of 2013 (gov.za); Information Regulator | Breach notice believed "as soon as reasonably possible" (s22), **not** 72 h: verify |
| CDPA | Cyber and Data Protection Act [Chapter 12:07] (Zimbabwe); POTRAZ as Data Protection Authority; SI 155 of 2024 | Secondary sources: 24 h to POTRAZ, 72 h to data subjects (high risk): **primary text not checked** |
| BDPA | Data Protection Act, 2018 (Botswana); Information and Data Protection Commission | Confirm instrument, numbering and deadlines |
| ISO 27701 | ISO/IEC 27701 catalogue entry (2019; 2025 standalone edition) | Paid text: identifiers only / user-supplied |
| NIST CSF | NIST CSF 2.0 (nist.gov/cyberframework) and the CSF 2.0 reference data | Public domain; ingest from NIST data with `content_hash` |

### Known-unverified claims from the legacy app (never copy)
"72 h" breach rule attributed to POPIA and CDPA; generic "30-day" DSAR deadline; CDPA fines/penalties in the sample course; area names embedding deadlines. Treat all as unverified until a verifier signs off.

## Example

Shape of one seed-data entry (provenance is mandatory):

```json
{
  "framework": "GDPR",
  "version": { "label": "GDPR (EU) 2016/679", "status": "verified", "licenceClass": "open_reuse",
    "source": { "url": "https://eur-lex.europa.eu/eli/reg/2016/679/oj", "retrievedAt": "2026-10-14",
                "citation": "Regulation (EU) 2016/679, OJ L 119, 4.5.2016", "contentHash": "sha256:…" },
    "verifiedBy": "<named reviewer>", "verifiedAt": "<date>" },
  "requirements": [{ "ref": "Art. 33", "title": "Notification of a personal data breach to the supervisory authority", "textSource": "reference_only" }]
}
```

## Anti-patterns
- Typing legal requirements from memory into seed files or UI copy; "Breach Notification (72h)" as a template name; framework lists hard-coded in code or UI.
- Overwriting user mappings on re-load; reading seed data at request time instead of materialising per organisation; mutating a published version.
- Treating "no mappings" or "not assessed" as non-compliant; implying legal equivalence between frameworks.
- Copying paid standard text; ingesting content without `content_hash`, retrieval date and a verifier.

## Checklist
- [ ] Content has provenance (`source_url`, `retrieved_at`, `content_hash`), licence class and `verified` status; loader rejects the rest
- [ ] Assessments/mappings pin requirement (version); published versions untouched
- [ ] Load Default Mappings idempotent, transactional, audited, returns inserted/skipped/failed, `422 SEED_DATA_UNAVAILABLE` when empty
- [ ] No hard-coded framework/deadline values in code; deadline policies default to Not configured
- [ ] Copy includes the informative-only / not-legal-advice wording
- [ ] Source registry updated; unverified claims not shipped

## References
`docs/frameworks/source-registry.md`, ADR-0009, `grc-domain`, `database-and-tenancy` (seeds), frontend `compliance-frameworks`, `docs/reference/legacy-findings.md` (A.13).
