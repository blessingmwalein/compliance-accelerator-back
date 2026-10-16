/**
 * Semantic version of the HTTP contract (the OpenAPI document), independent of the app version.
 * Additive change => minor bump, breaking change => major bump, fix to docs only => patch.
 * Must equal `info.version` in `contracts/openapi.json` (enforced by a test and `openapi:check`)
 * and be recorded in `contracts/CHANGELOG.md`.
 */
export const CONTRACT_VERSION = '0.5.0';

/** URL major version of the API (`/api/v1`). Changes only on a breaking contract major. */
export const API_VERSION = 'v1';
