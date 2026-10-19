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

## Consequences of the hosting decision (2026-10-19)
- Both drivers now exist behind the same `StorageProvider` contract: `LocalStorageProvider` (development and tests) and `S3StorageProvider` (`@aws-sdk/client-s3`), selected by `STORAGE_DRIVER`. The first host is **Supabase Storage over its S3-compatible endpoint** — which is why the endpoint, bucket, region and key pair are configuration and not a Supabase-specific driver: the same code addresses R2, B2, Wasabi, MinIO or AWS S3.
- The interface as built is `put(key, data) -> {size, sha256}`, `get(key) -> Buffer | null`, `delete(key)`; downloads stay proxied streams. No signed URL is issued by either driver.
- The body limit was answered by **lowering the cap** rather than by pre-signed direct uploads: `EVIDENCE_MAX_BYTES` (default 4 MiB) is the ceiling a deployment advertises, and `GET /api/v1/meta` states it so no client carries its own number. Direct uploads and larger artefacts remain open for when a real document exceeds it.
- Keys are unchanged (`org/{organisationId}/…`) and the bucket is private: bytes reach a browser only through the authorised download endpoints.
- Procedure: see [../deployment-vercel.md](../deployment-vercel.md).

## Revisit when
Files larger than the proxy limit have to be accepted (pre-signed uploads), or an object-store-native feature (lifecycle rules, tiering, retention) is needed.
