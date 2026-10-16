# ADR-0002: Two repositories and an OpenAPI contract

- **Status:** Accepted
- **Date:** 2026-10-14

## Context
The product is delivered as `fca-backend` and `fca-frontend`, independent Git repositories (explicitly **no monorepo, no shared package**). They must evolve in lockstep without importing each other's source.

## Decision
1. The **backend owns the contract**: `contracts/openapi.json`, generated from the code (`npm run openapi:export`), committed, with `info.version` = `CONTRACT_VERSION` (`src/meta/contract-version.ts`) and a human changelog (`contracts/CHANGELOG.md`). Semver: additive = minor, breaking = major, docs-only = patch. While the contract is `0.x`, any minor change is treated as potentially breaking by clients.
2. Paths in the document are relative to the server URL `/api/v1` (`ignoreGlobalPrefix: true`), so clients configure one base URL and the generated code is prefix-free. `GET /api/v1/meta` returns `contractVersion` for runtime drift detection.
3. The **frontend pins** a copy: `contract/openapi.json` + `contract/CONTRACT_VERSION`, refreshed with `npm run api:sync` (a file copy from the sibling repository, overridable with `FCA_BACKEND_PATH`), then `npm run api:codegen` (RTK Query client in `src/api/generated`, committed, never hand-edited). `npm run api:check` fails when the pin or the generated code is stale; at runtime the app compares the backend's contract version with the pin.
4. **Drift controls (backend)**: `npm run openapi:check` and `src/meta/contract.spec.ts` fail when the committed document differs from the generated one or lacks a changelog entry.
5. Errors are **RFC 9457 `application/problem+json`** with a stable `code`, `errors[{path,code,message}]` and `requestId`; documented per endpoint with `@ApiProblemResponse`.
6. **Contract-first sequencing**: the backend endpoint and its contract bump land first; the frontend then syncs and builds the UI; a phase closes only when both repositories pass `npm run verify`.

## Consequences
A typed end-to-end client with no source sharing, at the cost of a small ceremony per API change (export, bump, changelog, sync). Breaking changes require a major bump and a coordinated frontend release.

## Revisit when
A third consumer appears (then publish the contract as a versioned artefact) or `oasdiff`-style breaking-change detection is added to CI.
