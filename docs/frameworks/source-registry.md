# Framework source registry

Authoritative sources for framework content, their licence class and **verification status**. Every entry starts `verified: false`. Nothing is seeded, quoted in the UI or relied on for a deadline until its row is verified by a named person against the primary source (rules: `.claude/skills/compliance-frameworks/SKILL.md`, [ADR-0009](../adr/0009-framework-content-and-provenance.md)).

Software supports a compliance programme; it does not provide legal advice. Cross-framework mappings are informative and do not establish legal equivalence.

## Registry
| Framework | Jurisdiction / authority | Candidate authoritative source (lead) | Licence class | Version to model | verified | retrieved_at | verified_by |
|---|---|---|---|---|---|---|---|
| GDPR | EU (supervisory authorities, EDPB) | EUR-Lex, Regulation (EU) 2016/679: `https://eur-lex.europa.eu/eli/reg/2016/679/oj` | `open_reuse` (attribution) | GDPR (EU) 2016/679 | false | | |
| POPIA | South Africa (Information Regulator) | Protection of Personal Information Act 4 of 2013 (government gazette / gov.za; regulator site) | `open_reuse` (public law; confirm terms) | POPIA 2013 (+ regulations) | false | | |
| CDPA | Zimbabwe (POTRAZ as Data Protection Authority) | Cyber and Data Protection Act [Chapter 12:07]; Statutory Instrument 155 of 2024 (regulations): official gazette / Parliament | `open_reuse` (confirm) | CDPA 2021 (+ SI 155/2024) | false | | |
| BDPA | Botswana (Information and Data Protection Commission) | Data Protection Act, 2018 (confirm instrument, number, section numbering) | `open_reuse` (confirm) | BDPA 2018 | false | | |
| ISO 27701 | ISO/IEC (paid standard) | ISO catalogue: ISO/IEC 27701:2019 (`https://www.iso.org/standard/71670.html`) and the standalone ISO/IEC 27701:2025 edition (per certification bodies, published 14 October 2025; locate the catalogue entry) | `licensed_text` → identifiers/titles only or `user_supplied` | 27701:2019 **and** 27701:2025 | false | | |
| NIST CSF | US NIST (public domain) | NIST Cybersecurity Framework 2.0: `https://www.nist.gov/cyberframework` and the CSF 2.0 reference data (JSON/XLSX) | `public_domain` | CSF 2.0 | false | | |

URLs marked as leads have **not** been fetched; confirm each before recording `retrieved_at` and a `content_hash`.

## Packs extracted so far (Phase 4)
Each pack is `prisma/seed-data/<framework>/<version>/pack.json` next to the stored source file it was parsed from (`npm run frameworks:status` prints the current state). **Both are DRAFTS: nobody has verified them, so nothing is loaded into any database.** The `verified` column above stays `false` until a named person runs `npm run frameworks:verify`.

| Pack | Source actually fetched | Retrieved (UTC) | SHA-256 of the stored source file | Content | Notes for the verifier |
|---|---|---|---|---|---|
| `nist-csf/2.0` (NIST CSF 2.0, `public_domain`) | `https://csrc.nist.gov/extensions/nudp/services/json/csf/download?olirids=all` (the CSF 2.0 Reference Tool export, an .xlsx despite the URL) | 2026-10-16T12:10:28Z | `6852e20a06f51f0e594c3d5ad40873f79e33c6e9386d620e0b2f32667ddf5f87` | 134 requirements: 6 functions, 22 categories, 106 subcategories, words copied from the cells | The export says it is "a user generated version of the Core versus an official NIST publication": compare with NIST CSWP 29 (`https://nvlpubs.nist.gov/nistpubs/CSWP/NIST.CSWP.29.pdf`). 91 entries marked "[Withdrawn: ...]" (CSF 1.1 items: 12 categories, 79 subcategories) were left out. The counts match the published structure of CSF 2.0 |
| `gdpr/2016-679` (GDPR (EU) 2016/679, `open_reuse`) | `https://publications.europa.eu/resource/celex/32016R0679` with `Accept: application/xhtml+xml` (English Official Journal text; the EUR-Lex pages themselves answer a bot challenge) | 2026-10-16T12:08:57Z | `962539af03738bf552319ff4ce42d69e5f95a576307c4dfed7bf87e81b646b9d` | 110 requirements: 11 chapters, 99 articles, headings copied word for word; `effectiveFrom` 2018-05-25 is read from the text of Article 99; the operative text is NOT stored | Compare the chapter and article headings with the Official Journal / EUR-Lex. Sections within chapters are not modelled (articles sit under their chapter) |

The `content_hash` that a verification binds to is in each `pack.json` (`version.contentHash`). Re-running `npm run frameworks:extract -- <nist|gdpr>` re-parses the stored file (add `--refresh` to download again, which changes the source hash); a verified pack is never rewritten.

## Verification procedure (per framework version)
1. Obtain the **primary** text (official gazette, EUR-Lex, NIST data, licensed copy). Record URL/citation, retrieval date, and compute `content_hash` of the stored source file.
2. Transcribe or ingest into the seed JSON schema (`textSource`: `verbatim`, `paraphrase` or `reference_only` as the licence allows).
3. A **second named person** (legal reviewer or DPO) compares against the source; sets `verified_by` and `verified_at`.
4. Status moves `draft → verified`; publishing makes it immutable (`published`). Corrections create a new version.
5. Update this registry and the changelog; the seed loader accepts only `verified`.

## Deadline policy leads (NOT rules; do not enable without verification)
| Topic | Lead | Source of the lead | Status |
|---|---|---|---|
| CDPA breach notice to the authority | 24 hours | secondary law-firm summaries citing SI 155 of 2024 | unverified; primary text not checked |
| CDPA breach notice to data subjects | 72 hours where high risk | same | unverified |
| POPIA breach notice | "as soon as reasonably possible" (s22), no fixed 72 hours | statute wording (to verify) | unverified |
| GDPR breach notice to the authority | 72 hours (Art. 33) | statute | to verify against EUR-Lex |
| GDPR DSAR response | one month, extendable (Art. 12(3)) | statute | to verify against EUR-Lex |
| BDPA deadlines | unknown | none | research needed |

## Known-unverified claims in the legacy app (never copy)
See [legacy-findings.md](../reference/legacy-findings.md) A.13: the "72 h" breach rule attributed to POPIA and CDPA; the generic "30-day" DSAR deadline; CDPA fines and penalties in the sample course; deadlines embedded in template area names.

## Open questions for the owner
1. Who is the named **legal reviewer/verifier** for CDPA, POPIA and BDPA content?
2. Which Botswana instrument is meant by "BDPA" (the legacy text says *Botswana Data Protection Act, 2018*)?
3. Is a licensed copy of ISO/IEC 27701 available to customers, or should the framework stay a `user_supplied` shell?
4. Should the 2019 and 2025 editions of ISO/IEC 27701 both be offered?
