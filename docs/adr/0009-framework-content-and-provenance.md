# ADR-0009: Framework content, mappings and provenance

- **Status:** Accepted (schema in Phase 3, content in Phase 4)
- **Date:** 2026-10-14

## Context
The spec forbids fabricating legal obligations and requires versioned, authoritatively sourced content. The legacy templates and course text contained unverified legal claims (for example "72 h" for POPIA and CDPA). ISO standards are paid and copyrighted; NIST CSF is public domain; statutes need official text.

## Decision
- Global reference tables `framework → framework_version → requirement` and `mapping_pack_entry`; organisation layer `organisation_framework` (version in use) and `organisation_mapping` (seed or user origin, mandatory rationale for user rows). Version status **draft → verified → published → superseded**; published is immutable; provenance (citation, URL, retrieved_at, verifier, content_hash) and a licence class are mandatory.
- Seed packs are schema-validated JSON under `prisma/seed-data/<framework>/<version>/`; the loader **rejects anything not `verified`**. Empty packs are valid. **Load Default Mappings** is idempotent, transactional, never overwrites user rows, returns inserted/skipped/failed, and returns `422 SEED_DATA_UNAVAILABLE` with zero writes when no verified pack exists.
- Realistic Phase 4 content: NIST CSF 2.0 Core and GDPR (EUR-Lex). CDPA, POPIA and BDPA only after the owner supplies or approves official text; ISO 27701 as a `user_supplied` shell (2019 and 2025 editions modelled); no cross-framework mapping without a cited crosswalk or a named legal reviewer.
- Legal deadlines are **policy data with provenance**, default Not configured.

## Consequences
Phase 4 content can be smaller than the spec hoped for; that is intentional and visible in the UI ("No verified content yet"). A human verifier is a hard dependency.

## Revisit when
The owner names a legal reviewer, or a licensed ISO content partnership exists.
