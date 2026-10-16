# ADR-0007: Evidence storage

- **Status:** Accepted (thin core in Phase 5, full repository in Phase 7)
- **Date:** 2026-10-14

## Decision
- `StorageProvider` interface (`put` stream returning `{key,size,sha256}`, `stream`, `signedUrl`, `delete`) with a **local filesystem** driver (development and test; `.local-storage/`, git-ignored) and an **S3-compatible** driver (production: R2, S3, B2 or MinIO; provider chosen at G0).
- Opaque keys `org/{organisationId}/evidence/{evidenceId}/{version}`; the original filename lives only in the database; versions are immutable.
- v1 downloads are **proxied streams** (authorisation and audit on every download, `Content-Disposition: attachment`, `nosniff`). Signed URLs (at most 60 seconds) sit behind the same interface for later. Serverless body limits (for example about 4.5 MB) would force pre-signed direct uploads: decide at the hosting gate.
- Validation: allow-list of types, **magic-byte sniffing**, no SVG/HTML/executables/archives, a size cap, server-side SHA-256, filename sanitisation.
- `VirusScanner` interface (`pending_scan`, `clean`, `infected`, `not_scanned`; production fail-closed; no third-party public scanners for customer evidence).
- Disposal only through one `assertDisposable()` that honours **legal holds** (organisation, record type or record); soft-delete then audited purge; typed link tables rather than polymorphic links.

## Revisit when
Hosting or storage is chosen, or files larger than the proxy limit are needed.
