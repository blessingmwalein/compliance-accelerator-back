# Contract changelog

The HTTP contract is `contracts/openapi.json` (`info.version` = `CONTRACT_VERSION` in
`src/meta/contract-version.ts`). Additive change => minor, breaking change => major, docs-only => patch.
Record every bump here in the same commit that regenerates the document (`npm run openapi:export`).
The frontend pins a contract version in its own repository (`contract/CONTRACT_VERSION`).

## 0.5.0 - Phase 4 compliance mapping and framework content (additive)

New endpoints (under `/api/v1`; every operation carries `x-access` / `x-permission`). Lists are cursor pages (`limit`, `after`).

| Method | Path | operationId | Access | Notes |
|---|---|---|---|---|
| GET | `/frameworks/reference-guide` | `getFrameworkReferenceGuide` | authenticated | every catalogue framework with its loaded, verified versions (source URL, citation, verifier, `verifiedAt` = last reviewed, hashes) or `currentVersion: null` ("No verified content yet"), plus the informative-only `disclaimer` |
| GET | `/framework-versions/{versionId}/requirements` | `listRequirements` | authenticated | the requirement tree of a loaded version: filters `q`, `parentId`, `kind`; identifiers and titles only, never the operative text of a law |
| GET · POST | `/organisations/{organisationId}/governance-areas` | `listGovernanceAreas` · `createGovernanceArea` | `mapping.view` · `mapping.edit` | list filters `includeArchived`, `q`; `409 GOVERNANCE_AREA_NAME_TAKEN` |
| PATCH | `…/governance-areas/{areaId}` | `updateGovernanceArea` | `mapping.edit` | sends `version` |
| POST | `…/governance-areas/{areaId}/archive` · `/unarchive` | `archiveGovernanceArea` · `unarchiveGovernanceArea` | `mapping.edit` | archived, never deleted |
| GET · POST | `…/compliance-mappings` | `listMappings` · `createMapping` | `mapping.view` · `mapping.edit` | list filters `q`, `areaId`, `frameworkId`, `relationship`, `reviewStatus`, `includeArchived` |
| GET | `…/compliance-mappings/matrix` | `getMappingMatrix` | `mapping.view` | the mapping table: a page of governance areas (plus, on the first page, the row of mappings that have no area) with `entries` the client places in framework columns; an archived area stays as a row (`areaArchived: true`) while it still holds mappings |
| POST | `…/compliance-mappings/load-defaults` | `loadDefaultMappings` | `mapping.loadDefaults` | copies the verified default pack for the applicable frameworks; `200 { inserted, skipped, failed, frameworks }`, or `422` with nothing written |
| GET · PATCH | `…/compliance-mappings/{mappingId}` | `getMapping` · `updateMapping` | `mapping.view` · `mapping.edit` | PATCH sends `version` |
| POST | `…/compliance-mappings/{mappingId}/archive` · `/unarchive` | `archiveMapping` · `unarchiveMapping` | `mapping.edit` | archived, never deleted |

New error codes: `GOVERNANCE_AREA_NAME_TAKEN`, `MAPPING_ALREADY_EXISTS` (409: the same two requirements are already mapped, in either direction), `SEED_DATA_UNAVAILABLE` (422: no verified default pack for the applicable frameworks; nothing was written), `NO_FRAMEWORKS_SELECTED` (422). Field error codes on mappings: `unknownArea`, `areaArchived`, `unknownRequirement`, `requirementUnavailable`, `sameRequirement`, `sameFramework`, `seededMappingLocked`.

Behaviour that is not visible in the schema: a mapping links requirements of two DIFFERENT frameworks, both in a loaded and verified version; a mapping copied from the default pack (`origin: SEED`) can only change its area and review status; a pack entry is copied into an organisation at most once, also after it was archived; framework content is loaded only by the owner-run tooling after a named person verified it, so a fresh installation has no requirements and `reference-guide` says so.

## 0.4.0 - Phase 3 setup modules (additive)

New endpoints (under `/api/v1`; every operation carries `x-access` / `x-permission`). Lists are cursor pages (`limit`, `after`) except the fixed reference lists.

| Method | Path | operationId | Access | Notes |
|---|---|---|---|---|
| GET · PATCH | `/organisations/{organisationId}/settings` | `getSettings` · `updateSettings` | `company.view` · `company.edit` | company information and the DPO contact; PATCH sends `version`; omit a field to keep it, send `null` or a blank string to clear it; changing `displayName` also needs `company.branding` (`403`) |
| PUT · GET · DELETE | `…/settings/logo` | `uploadLogo` · `downloadLogo` · `removeLogo` | `company.branding` · organisation-member · `company.branding` | multipart field `file`: PNG or JPEG up to 512 KiB, checked by its bytes (`413`, `415`); the image is served only to members, with `ETag` |
| GET · POST | `…/regulator-contacts` | `listRegulatorContacts` · `createRegulatorContact` | `company.view` · `company.edit` | cursor page |
| PATCH · DELETE | `…/regulator-contacts/{contactId}` | `updateRegulatorContact` · `deleteRegulatorContact` | `company.edit` | PATCH sends `version` |
| GET · POST | `…/business-units` | `listBusinessUnits` · `createBusinessUnit` | `businessUnits.view` · `businessUnits.create` | list filters `includeArchived`, `q`; `409 BUSINESS_UNIT_NAME_TAKEN` / `BUSINESS_UNIT_CODE_TAKEN` |
| PATCH | `…/business-units/{businessUnitId}` | `updateBusinessUnit` | `businessUnits.edit` | sends `version` |
| POST | `…/business-units/{businessUnitId}/archive` · `/unarchive` | `archiveBusinessUnit` · `unarchiveBusinessUnit` | `businessUnits.delete` | units are archived, never deleted |
| GET | `/frameworks` | `listFrameworks` | authenticated | the catalogue: identifiers only, no legal text |
| GET · PUT | `…/frameworks` | `listOrganisationFrameworks` · `setOrganisationFrameworks` | `company.view` · `company.edit` | PUT sends the full desired set `{ frameworkIds }`; a removed framework keeps its history |
| GET | `/plans` | `listPlans` | authenticated | visible plans (limits are placeholders until commercially confirmed) |
| GET | `…/subscription` | `getSubscription` | `subscription.view` | plan snapshot and usage; `assigned: false` = no plan, nothing limited |
| GET | `/platform/plans` | `listAllPlans` | platform | including hidden plans |
| PATCH | `/platform/plans/{planId}` | `setPlanVisibility` | platform | hiding a plan never changes an organisation that has it |
| PUT | `/platform/organisations/{organisationId}/plan` | `assignPlan` | platform | snapshots the plan's limits for the organisation |

Changed: `POST /platform/organisations` accepts an optional `planId`; `PlatformOrganisationDto` has `planName`.

Fields worth knowing (see `docs/integration.md`, "Setup modules"): settings carry `sector`; `country` and `dpoEmail` are required in substance (they cannot be cleared; an organisation created earlier returns `null` until they are filled in); business units carry `headMembershipId` (an active member) with `headName`, `sensitivity` (1 to 5, `null` = not classified), `employeeCount` and `parentId` with `parentName`; field errors `notAnActiveMember`, `unknownParent`, `parentArchived`, `parentIsSelf`, `parentCycle`, `unknownFramework`.

New error codes: `BUSINESS_UNIT_NAME_TAKEN`, `BUSINESS_UNIT_CODE_TAKEN`, `BUSINESS_UNIT_HAS_CHILDREN` (409: the unit still has active children), `USER_LIMIT_REACHED` (403: inviting or reactivating would exceed the plan's user limit; open invitations count).

Behaviour changes that are not visible in the schema: with a plan assigned, `POST …/invitations` and `POST …/members/{id}/reactivate` are refused with `USER_LIMIT_REACHED` when the limit is reached; with no plan nothing is limited.

## 0.3.0 - Phase 2c organisations, members, invitations, platform (additive)

New endpoints (all under `/api/v1`; errors are problem+json with stable codes). Every operation now carries
`x-access` (`public` | `authenticated` | `permission` | `organisation-member` | `platform`) and, where it applies,
`x-permission` (a key of the permission catalogue, `docs/rbac-matrix.md`).

| Method | Path | operationId | Access | Notes |
|---|---|---|---|---|
| GET | `/organisations` | `listMyOrganisations` | authenticated | the caller's active organisations with their role |
| POST | `/organisations` | `createOrganisation` | authenticated | 201; the caller becomes Company Owner; `403 SELF_SERVE_DISABLED` unless the deployment allows it |
| GET | `/organisations/{organisationId}/me` | `getMyMembership` | organisation-member | role + every permission of the role (enum `Permission`) |
| GET | `/organisations/{organisationId}/members` | `listMembers` | `users.view` | cursor page (`limit`, `after`) |
| PATCH | `/organisations/{organisationId}/members/{membershipId}` | `changeMemberRole` | `users.edit` | body `{ role, version }`; `409 VERSION_CONFLICT`, `409 LAST_OWNER`, `403 OWNER_ONLY`, `403 SELF_CHANGE_NOT_ALLOWED` |
| POST | `/organisations/{organisationId}/members/{membershipId}/deactivate` | `deactivateMember` | `users.delete` | body `{ version }` |
| POST | `/organisations/{organisationId}/members/{membershipId}/reactivate` | `reactivateMember` | `users.delete` | body `{ version }` |
| GET | `/organisations/{organisationId}/invitations` | `listInvitations` | `users.view` | cursor page, newest first; `state` includes the computed `EXPIRED` |
| POST | `/organisations/{organisationId}/invitations` | `createInvitation` | `users.create` | 201; `409 ALREADY_MEMBER`, `409 INVITATION_PENDING`, `403 OWNER_ONLY` |
| POST | `/organisations/{organisationId}/invitations/{invitationId}/resend` | `resendInvitation` | `users.create` | at most one email per 5 minutes |
| POST | `/organisations/{organisationId}/invitations/{invitationId}/revoke` | `revokeInvitation` | `users.create` | idempotent |
| POST | `/invitations/inspect` | `inspectInvitation` | authenticated | body `{ token }`; organisation name and role; `400 INVALID_TOKEN` |
| POST | `/invitations/accept` | `acceptInvitation` | authenticated | body `{ token }`; `403 INVITATION_EMAIL_MISMATCH`, `403 EMAIL_NOT_VERIFIED`, `409 ALREADY_MEMBER` |
| GET | `/platform/organisations` | `listPlatformOrganisations` | platform | names and counts only |
| POST | `/platform/organisations` | `provisionOrganisation` | platform | creates the organisation and invites the first Owner |

Changed: `GET /me` also returns `isPlatformAdmin`; `GET /meta` also returns `organisationSelfServe` (whether `POST /organisations` is enabled, so the UI can hide the form). List operations document their `limit` (1 to 100, default 50) and `after` query parameters.

New error codes: `LAST_OWNER`, `ALREADY_MEMBER`, `INVITATION_PENDING`, `INVITATION_EMAIL_MISMATCH`, `VERSION_CONFLICT`, `OWNER_ONLY`, `SELF_CHANGE_NOT_ALLOWED`, `SELF_SERVE_DISABLED`.

Behaviour changes that are not visible in the schema:

- Organisation routes answer **404** to a non-member, a deactivated member and an unknown organisation alike; a member whose role lacks the permission gets **403** before anything is looked up. A route without an access declaration is denied.
- Invitation emails link to the SPA page `/accept-invitation#token=...` (token in the URL fragment); the SPA POSTs it. The invitee must be signed in with the invited address, confirmed.
- Member and invitation changes are versioned (`version`) and audited in the same transaction.

## 0.2.0 - Phase 2b authentication (additive)

New endpoints (all under `/api/v1`; errors are problem+json with stable codes):

| Method | Path | operationId | Success | Notes |
|---|---|---|---|---|
| POST | `/auth/register` | `register` | 202 `{ accepted }` | uniform: same answer whether or not the address exists; weak passwords are `400 VALIDATION_FAILED` with `password.*` codes |
| POST | `/auth/resend-verification` | `resendVerification` | 202 | uniform |
| POST | `/auth/verify-email` | `verifyEmail` | 204 | body `{ token }`; single use; `400 INVALID_TOKEN` |
| POST | `/auth/login` | `login` | 200 `{ accessToken, tokenType, expiresInSeconds }` | sets the HttpOnly `fca_refresh` cookie (path `/api/v1/auth`); `401 INVALID_CREDENTIALS`, `403 EMAIL_NOT_VERIFIED`, `429 RATE_LIMITED` + `Retry-After` |
| POST | `/auth/refresh` | `refreshSession` | 200 (same body) | cookie + header `X-Requested-With: fca-web`; rotates the cookie; `401` clears it |
| POST | `/auth/logout` | `logout` | 204 | cookie + `X-Requested-With: fca-web`; idempotent |
| POST | `/auth/forgot-password` | `forgotPassword` | 202 | uniform |
| POST | `/auth/reset-password` | `resetPassword` | 204 | body `{ token, password }`; ends every session |
| GET | `/me` | `getMe` | 200 `{ id, email, fullName, emailVerified, createdAt }` | needs `Authorization: Bearer` |

New error codes: `INVALID_CREDENTIALS`, `EMAIL_NOT_VERIFIED`, `INVALID_TOKEN`.

Behaviour changes that are not visible in the schema:

- Every route other than `/health*`, `/meta` and `/auth/*` now requires a bearer token (deny by default).
- Email links open SPA pages and carry the one-time token in the URL **fragment**: `/verify-email#token=...`, `/reset-password#token=...`; the SPA POSTs it. Other SPA paths used by emails: `/login`, `/forgot-password`.
- `POST /internal/jobs/tick` exists but is an operational endpoint (HMAC-signed), deliberately **not** in this contract.

## 0.1.0 - Phase 0 baseline

- `GET /health` liveness, `GET /health/ready` readiness (database), `GET /meta` build + contract version.
- Errors are RFC 9457 `application/problem+json` with stable `code`, optional `errors[]` and `requestId`.
