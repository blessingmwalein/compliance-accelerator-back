# Integration: how fca-frontend consumes this API

**This file is authoritative.** `fca-frontend/docs/integration.md` mirrors it from the consumer side. If they disagree, this one wins; fix the other.

## At a glance
| Item | Value |
|---|---|
| API base URL (local) | `http://localhost:3001/api/v1` |
| Swagger UI / raw document | `http://localhost:3001/api/docs` · `/api/docs-json` |
| Web app origin (local) | `http://localhost:5173` (allowed by `CORS_ORIGINS`) |
| **Contract version** | **0.5.0** (`src/meta/contract-version.ts`, `contracts/openapi.json` `info.version`, `GET /meta`) |
| API major | `v1` (URL prefix) |
| Content type | `application/json`; errors `application/problem+json` |
| Tenant routes | `/api/v1/organisations/:organisationId/…` |
| Non-tenant routes | `/auth/*`, `/me`, `/frameworks`, `/plans`, `/platform/*`, `/health*`, `/meta` |

Local ports: API **3001**, web **5173** (Vite dev), 4173 (Vite preview). Neon is remote; there is no local Postgres or mail server.

## Contract workflow
1. Backend change → `npm run openapi:export` → bump `CONTRACT_VERSION` → add `contracts/CHANGELOG.md` entry → `npm run verify`.
2. Frontend: `npm run api:sync` (copies `../fca-backend/contracts/openapi.json` to `contract/openapi.json` and writes `contract/CONTRACT_VERSION`; override the path with `FCA_BACKEND_PATH`) → `npm run api:codegen` → `npm run verify`.
3. Semver: additive = minor, breaking = major, docs-only = patch. While `0.x`, the frontend treats a different **minor** as incompatible. At runtime the frontend compares `GET /meta` → `contractVersion` with its pin and shows a mismatch warning.
4. Never import across repositories. The only artefact that moves is the OpenAPI document.

## Authentication (from Phase 2b; see ADR-0003)
- `Authorization: Bearer <access token>` (≈15 min, kept in memory by the SPA).
- Refresh: `POST /api/v1/auth/refresh` with the `HttpOnly` cookie (send `credentials: 'include'`); on boot and after a 401 (single-flight). Cookie is `SameSite=Lax`, scoped to `/api/v1/auth`.
- Production requires web and API to be **same-site** (shared registrable domain) or a host rewrite of `/api/*`; decided at gate G0.
- Cookie endpoints (`/auth/refresh`, `/auth/logout`) also require the header `X-Requested-With: fca-web` (CSRF defence; allowed by CORS) in addition to the exact-origin check.
- Verification, reset and invitation links open **SPA pages** that POST the token; the API never consumes tokens on GET.

### Contract for the web app (built in Phase 2b, contract 0.2.0)
| Call | Success | Failure codes the UI must handle |
|---|---|---|
| `POST /auth/register` `{ email, password, fullName }` | `202 { accepted: true }` (always, even for an existing address: say "check your email") | `400 VALIDATION_FAILED` with `errors[]` paths `email`, `password`, `fullName`; password codes `password.tooShort`, `password.tooLong`, `password.tooCommon`, `password.tooSimple`, `password.containsEmail` |
| `POST /auth/resend-verification` `{ email }` | `202` (always) | |
| `POST /auth/verify-email` `{ token }` | `204` | `400 INVALID_TOKEN` (used, expired or unknown: offer "resend") |
| `POST /auth/login` `{ email, password }` | `200 { accessToken, tokenType: "Bearer", expiresInSeconds }` + `fca_refresh` cookie | `401 INVALID_CREDENTIALS`, `403 EMAIL_NOT_VERIFIED` (offer resend), `429 RATE_LIMITED` with `Retry-After` (seconds), `503 DATABASE_UNAVAILABLE` with `Retry-After` |
| `POST /auth/refresh` (cookie + `X-Requested-With: fca-web`, no body) | `200` (same body as login), cookie rotated | `401 UNAUTHENTICATED` (cookie cleared: go to sign-in), `403 FORBIDDEN` (header missing: a client bug) |
| `POST /auth/logout` (cookie + header) | `204`, cookie cleared | |
| `POST /auth/forgot-password` `{ email }` | `202` (always) | |
| `POST /auth/reset-password` `{ token, password }` | `204`; every session of the user is ended: sign in again | `400 INVALID_TOKEN`, `400 VALIDATION_FAILED` (weak password; the link is **not** consumed) |
| `GET /me` (bearer) | `200 { id, email, fullName, emailVerified, createdAt }` | `401 UNAUTHENTICATED` |

- **Cookie**: name `fca_refresh`, `HttpOnly`, `SameSite=Lax`, `Path=/api/v1/auth`, `Secure` in production. JavaScript never sees it; fetch with `credentials: 'include'`.
- **Access token**: send as `Authorization: Bearer`; keep in memory only. After any `401` on an API call, call `POST /auth/refresh` once (single-flight) and retry; a failed refresh means signed out. Two tabs refreshing at the same moment is tolerated (10-second grace); a token replayed after that signs the session out everywhere.
- **Email links** open SPA routes and carry the one-time token in the URL **fragment**: `/verify-email#token=…`, `/reset-password#token=…` (read `location.hash`, POST the token, then clear the fragment from the address bar). Emails also link to `/login` and `/forgot-password`.
- Everything except `/health*`, `/meta` and `/auth/*` requires the bearer token.
- `503 DATABASE_UNAVAILABLE` (with `Retry-After: 5`) means the database is unreachable or waking up: show a "try again" state, not a generic error.
- **Dev mail**: with `MAIL_TRANSPORT=file` no email is delivered; messages are written to `DEV_MAIL_DIR` (default `.dev-mail`, git-ignored) as `.eml` files and the link is logged by the API. A real provider is a gate G0 decision.
- **Operational endpoint (not in the contract)**: `POST /api/v1/internal/jobs/tick` is called by a host scheduler, signed with `X-FCA-Timestamp` (unix seconds) and `X-FCA-Signature` = hex HMAC-SHA256 of `"<timestamp>.POST./api/v1/internal/jobs/tick"` with `JOBS_TICK_SECRET`; answers `200 { claimed, succeeded, retried, dead }`, `401` on a bad signature, `404` when no secret is configured.

## Conventions
- **Errors** (RFC 9457): `{ type, title, status, detail?, code, errors?: [{ path, code, message? }], requestId }`. Branch on `code`. `requestId` equals the `X-Request-Id` response header; show it in "report a problem" UI.
- **Request id**: send `X-Request-Id` (8–64 chars `[A-Za-z0-9._-]`) to correlate; otherwise one is generated.
- **Pagination** (cursor, no offset): `?limit=` (1 to 100, default 50) and `?after=<nextCursor>`; response `{ items, nextCursor }` (`nextCursor` is null on the last page).
- **Idempotency**: creating `POST`s accept `Idempotency-Key`.
- **Concurrency**: updates carry the resource `version`; a stale one → `409 VERSION_CONFLICT`.
- **Dates**: instants are ISO 8601 UTC; date-only fields are `YYYY-MM-DD`; deadlines are evaluated in the organisation's timezone on the server.
- **Metric states** (dashboard): `availability` (`ok|not_configured|not_assessed|no_records|unable_to_calculate`) + `status` (`in_progress|compliant|needs_attention|overdue|null`); never infer them client-side.
- **Status codes**: 400 validation, 401 unauthenticated, 403 lacks permission (member), 404 unknown **or foreign** record, 409 conflict, 422 domain-rule violation, 429 rate limited, 503 dependency down.
- **CORS**: exact origins from `CORS_ORIGINS`, credentials allowed; allowed request headers `Content-Type`, `Authorization`, `X-Request-Id`, `X-Requested-With`, `Idempotency-Key`; exposed response headers `X-Request-Id`, `Content-Disposition` (needed to name downloads).

## Current surface (contract 0.5.0)
| Method | Path | operationId | Notes |
|---|---|---|---|
| GET | `/health` | `getHealth` | liveness (public, never rate limited) |
| GET | `/health/ready` | `getReadiness` | 503 problem+json (`DATABASE_NOT_CONFIGURED` / `DATABASE_UNAVAILABLE`) when the database is missing or down |
| GET | `/meta` | `getMeta` | `{ name, version, contractVersion, apiVersion, organisationSelfServe }` |
| POST | `/auth/register` · `/auth/resend-verification` · `/auth/verify-email` · `/auth/login` · `/auth/refresh` · `/auth/logout` · `/auth/forgot-password` · `/auth/reset-password` | `register` · `resendVerification` · `verifyEmail` · `login` · `refreshSession` · `logout` · `forgotPassword` · `resetPassword` | see "Contract for the web app" above |
| GET | `/me` | `getMe` | signed-in user, with `isPlatformAdmin` |
| | organisations, members, invitations, platform | see "Organisations and access" below | 15 operations added in 0.3.0 |
| | settings, regulator contacts, logo, business units, frameworks, plans, subscription, platform plans | see "Setup modules" below | 20 operations added in 0.4.0 |
| | reference guide, requirements, governance areas, compliance mappings, matrix, Load Default Mappings | see "Compliance mapping" below | 15 operations added in 0.5.0 |

## Organisations and access (Phase 2c, contract 0.3.0)

Every operation in the contract carries `x-access` (`public` · `authenticated` · `permission` · `organisation-member` · `platform`) and, where it applies, `x-permission` (a key of the catalogue in [rbac-matrix.md](rbac-matrix.md)). The frontend reads what the CALLER may do from `GET /organisations/:organisationId/me` (`role` and `permissions`) and uses it to show or hide actions; the server enforces every permission on every request.

| Method | Path | operationId | Access | Notes |
|---|---|---|---|---|
| GET | `/organisations` | `listMyOrganisations` | authenticated | the caller's active organisations with their role |
| POST | `/organisations` | `createOrganisation` | authenticated | self-serve; `403 SELF_SERVE_DISABLED` unless `ORGANISATIONS_SELF_SERVE` is on (`GET /meta` → `organisationSelfServe`) |
| GET | `/organisations/{organisationId}/me` | `getMyMembership` | organisation-member | role + every permission of the role |
| GET | `…/members` | `listMembers` | `users.view` | cursor page |
| PATCH | `…/members/{membershipId}` | `changeMemberRole` | `users.edit` | body `{ role, version }` |
| POST | `…/members/{membershipId}/deactivate` · `/reactivate` | `deactivateMember` · `reactivateMember` | `users.delete` | body `{ version }` |
| GET · POST | `…/invitations` | `listInvitations` · `createInvitation` | `users.view` · `users.create` | `state` includes the computed `EXPIRED` |
| POST | `…/invitations/{invitationId}/resend` · `/revoke` | `resendInvitation` · `revokeInvitation` | `users.create` | resend: at most one email per 5 minutes |
| POST | `/invitations/inspect` · `/invitations/accept` | `inspectInvitation` · `acceptInvitation` | authenticated | body `{ token }` |
| GET · POST | `/platform/organisations` | `listPlatformOrganisations` · `provisionOrganisation` | platform | names and counts only; provisioning invites the first Owner |

- **404 versus 403.** A non-member, a deactivated member and an unknown organisation all get `404`; a member whose role lacks the permission gets `403`, decided before anything is looked up. The UI shows one "not found" for the three 404 cases.
- **Roles.** Only an Owner grants, changes or removes the Owner role (`403 OWNER_ONLY`); nobody changes their own role or deactivates themselves (`403 SELF_CHANGE_NOT_ALLOWED`); an organisation always keeps one active Owner, also under concurrent requests (`409 LAST_OWNER`).
- **Invitation link.** The email links to the SPA page `/accept-invitation#token=…` (token in the fragment, POSTed by the page). The invitee signs in (or registers and confirms) with the **invited address** and accepts. Wrong account: `403 INVITATION_EMAIL_MISMATCH`; unconfirmed address: `403 EMAIL_NOT_VERIFIED`; unknown, expired, used, revoked or replaced link: one uniform `400 INVALID_TOKEN`.
- **Platform administrators** are made with `npm run platform-admin -- grant <email>` (owner credentials, direct database URL), never through the API. They see names and counts only and are not members of what they provision.

## Setup modules (Phase 3, contract 0.4.0)

Operation names, paths and permissions are in [contracts/CHANGELOG.md](../contracts/CHANGELOG.md) (0.4.0) and in the contract itself (`x-access` / `x-permission`). What the generated types do not say:

- **PATCH semantics** (settings, regulator contacts, business units): a field left out keeps its value; `null` or a blank string clears it; `version` is required and a stale one is `409 VERSION_CONFLICT`. Required fields are the exception: `name`, `timezone`, **`country` and `dpoEmail` cannot be cleared**; sending `null` or a blank string for them leaves the value unchanged (no error), so the form must validate them itself. `GET …/settings` returns `country` and `dpoEmail` as `null` for an organisation created before they were asked for (every organisation provisioned or created through the API until now), which the UI should show as "incomplete".
- **Display name** needs `company.branding` on top of `company.edit` (`403` otherwise); the form should disable that one field for roles without it.
- **Logo**: `PUT …/settings/logo` is `multipart/form-data` with the single field `file` (PNG or JPEG, up to 512 KiB; `413` too large, `415` not an accepted image, decided by the bytes, never by the file name). `GET …/settings/logo` answers the image with `ETag` (honour `If-None-Match`), `Cache-Control: private`, `nosniff`; it needs the bearer token, so fetch it with the API client and show a blob URL, not a bare `<img src>`. `404` = no logo. Changing the logo does **not** change the settings `version`; the settings fields `hasLogo` and `logoUpdatedAt` tell whether there is one and when to refetch.
- **Business unit fields**: `headMembershipId` must be an ACTIVE member (field error `headMembershipId` / `notAnActiveMember`); `sensitivity` is 1 (Public) to 5 (Critical) or `null` = not classified (the labels are a frontend display concern); `employeeCount` ≥ 0 or `null`; `parentId` must be an active unit, not itself and not a descendant (field errors `parentId` / `unknownParent`, `parentArchived`, `parentIsSelf`, `parentCycle`). The DTO also returns `headName` and `parentName` so a table needs no extra calls. `code` is unique per organisation **including archived units**; `name` is unique among active units.
- **Archive**: `POST …/archive` is refused with `409 BUSINESS_UNIT_HAS_CHILDREN` while active children exist (the `detail` is plain language: show it). Archived units are listed only with `?includeArchived=true`.
- **Frameworks**: `GET /frameworks` is the catalogue (identifiers only: `code`, `name`, `jurisdiction`, `kind`; never legal text). `GET …/frameworks` returns the same entries with `applicable`, `addedAt` and `removedAt`. `PUT …/frameworks` sends the **complete desired set** `{ frameworkIds }`; an id that is not in the catalogue is `400 VALIDATION_FAILED` (`frameworkIds` / `unknownFramework`). The response is the resulting list.
- **Plans and limits**: `GET /plans` lists the visible plans. `GET …/subscription` returns `{ assigned, planCode, planName, maxUsers, apiAccess, assignedAt, activeMembers, pendingInvitations }`; `assigned: false` means **no plan and nothing is limited** (never show "0 users allowed"); `maxUsers: null` with a plan means unlimited. Plans carry `isPlaceholder`. When a limit is reached, inviting and reactivating answer `403 USER_LIMIT_REACHED`; the count is active members plus open invitations. The seeded plans and their limits are **placeholders**.
- **Platform**: `GET /platform/plans` includes hidden plans; hiding a plan never changes an organisation that already has it; `PUT /platform/organisations/{id}/plan` copies the plan's limits into a snapshot for that organisation; `POST /platform/organisations` accepts an optional `planId`.

## Compliance mapping (Phase 4, contract 0.5.0)

Operation names, paths and permissions are in [contracts/CHANGELOG.md](../contracts/CHANGELOG.md) (0.5.0) and in the contract (`x-access` / `x-permission`). What the generated types do not say:

- **Framework content is not seeded.** A fresh installation has no versions and no requirements: `GET /frameworks/reference-guide` returns every catalogue framework with `currentVersion: null`, which the UI shows as "No verified content yet". Content arrives only when the platform owner verifies and loads a pack (`npm run frameworks:verify`, `npm run frameworks:load`; see [neon-setup.md](neon-setup.md) section 8). Never hard-code a framework list or requirement text in a client.
- **Requirements** (`GET /framework-versions/{versionId}/requirements`) are identifiers and headings (`ref`, `kind`, `title`, `description`) in the pack's order, with `textSource` saying whether the words are the source's own. A version has at most a few hundred; a picker may read every page (`limit=100`, follow `nextCursor`) and search in the browser. The id of the version to use is `currentVersion.id` of the reference guide.
- **The mapping table** is `GET …/compliance-mappings/matrix`: one row per governance area, plus on the FIRST page a row with `areaId: null` for mappings filed under no area. Each row has flat `entries`; every mapping contributes two entries (one per side), and the client places each in the column of its `frameworkCode`. The columns themselves come from `GET /frameworks`, not from the matrix. A relationship or review-status filter leaves out areas without a matching mapping. An archived area appears (`areaArchived: true`) only while it still holds mappings that pass the filters.
- **Creating a mapping** needs `fromRequirementId` and `toRequirementId` (two requirements of DIFFERENT frameworks, both in a verified version), `relationship`, a non-blank `rationale` and optionally `areaId`, `reference` and `reviewStatus` (default `DRAFT`). Field errors (`errors[].path` + code): `fromRequirementId` / `toRequirementId` with `unknownRequirement`, `requirementUnavailable`, `sameRequirement`; `toRequirementId` with `sameFramework`; `areaId` with `unknownArea`, `areaArchived`. The same pair twice (either direction) is `409 MAPPING_ALREADY_EXISTS`.
- **Editing**: `origin: SEED` mappings (copied from a verified pack) accept only `areaId` and `reviewStatus`; anything else is `400` with `seededMappingLocked`. `null` clears `areaId` and `reference`; `rationale` can be replaced but not cleared.
- **Load Default Mappings** (`POST …/compliance-mappings/load-defaults`, no body): `200 { inserted, skipped, failed[], frameworks[] }` or `422` with `SEED_DATA_UNAVAILABLE` / `NO_FRAMEWORKS_SELECTED` and nothing written; the `detail` is plain language: show it. Today no pack carries mapping entries, so the answer is `422 SEED_DATA_UNAVAILABLE` for every organisation until a cited crosswalk is loaded.
- Every surface that shows mappings carries `disclaimer` from the matrix or the reference guide: *informative, not legal equivalence, not legal advice*.

## Run both locally
```powershell
# terminal 1
cd fca-backend ; npm ci ; Copy-Item .env.example .env ; npm run start:dev
# terminal 2
cd fca-frontend ; npm ci ; npm run api:sync ; npm run dev     # http://localhost:5173
```
