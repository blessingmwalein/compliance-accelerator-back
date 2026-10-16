# fca-backend implementation plan

Work proceeds in controlled phases. **Each phase ends with a report** (functionality, changed files, endpoints and contract version, migrations, tests run and results, known limitations, next task) and, because the Definition of Done spans both repositories, a phase closes only when **fca-backend and fca-frontend both pass `npm run verify`**. The frontend plan mirrors this file in its own repository.

The order below keeps the specification's phase numbers but splits two phases and moves cross-cutting infrastructure earlier ("◆") where later phases depend on it. Features are unchanged.

## Status
| Phase | Scope | Status |
|---|---|---|
| 0 | Repositories, skills, docs, minimal runnable scaffolds, contract round trip | **Built; verification results are in the Phase 0 report** |
| G0 | Decision gate (non-code), see below | open |
| 1 | Design system, shell, routes (frontend) | **Built** (frontend only; backend change limited to CORS `X-Requested-With` / `Content-Disposition` and explicit unique `operationId`s, contract still 0.1.0) |
| 2a ◆ | Neon wiring, base schema, audit write-side, tenancy harness | **Built and verified on Neon** (2026-10-15): both migrations applied, `test:int` 49/49 on `fca_test` as `fca_app`, spike S5 passed. RLS: mechanics pass, adoption deferred to 2c with the tenant repositories (ADR-0004) |
| 2b ◆ | Auth, email verification, reset, outbox + email | **Built in both repositories and verified on Neon** (contract 0.2.0): backend `test:int` 49/49, 8 Playwright journeys in Edge against the real API on Neon. Email is the file transport only (provider = G0) |
| 2c ◆ | Organisations, memberships, invitations, six roles, platform-admin flag, RBAC + tenancy matrices, row-level security | **Built in both repositories** (contract 0.3.0); backend `test:int` on Neon includes the generated matrices and the RLS spec. Frontend: organisation gate and switcher, User Management (members and invitations), accept-invitation, organisations list and creation, platform page. The Playwright journey is written but was **not run** (see the phase report) |
| 3 | Company Settings, Business Units, User Management, framework configuration, plans and entitlements | **Built in both repositories** (contract 0.4.0). `npm run verify` is green in both. **No new automated tests were added for Phase 3 (owner decision: "in plan dont do unit tests")**; the behaviour was checked with throwaway integration specs that were deleted afterwards, by the generated access matrix (27 routes) and by hand on the seeded demo company (`npm run seed:dev`). The Playwright journey was not run |
| 4 | Compliance Mapping + framework content | **Built in both repositories** (contract 0.5.0); `npm run verify` is green in both. **No new automated tests** (owner decision); the backend was checked by two throwaway in-process smoke runs against the dev database (58 checks, fixtures removed) and the page by a throwaway render check (all deleted). **Framework content is extracted but NOT loaded: it waits for a named person to verify it** (see Phase 4 below). Playwright not run |
| 5 | Governance Assessment, scoring, gap analysis, remediation, Eisenhower (+ evidence and report cores) | not started |
| 6 | Risk Register, Data Classification, Lawful Basis, RoPA, Retention | not started |
| 7 | DSAR, Breach, Evidence Repository, Reminders | not started |
| 8 | Executive dashboard | not started |
| 9a/9b/9c ◆ | Reports + Audit Trail UI / Training / User Manual | not started |
| 10 | AI Risk Assessment, subscription entitlements UI, integrations | not started |
| 11 | E2E, security, accessibility, deployment validation, release docs | not started |

## Gate G0 — decisions needed (owner)
| Decision | Needed before | Default if undecided |
|---|---|---|
| Hosting and **same-site domains** for web + API (refresh cookie) | 2b | dev only: `localhost` |
| Email provider (SPF/DKIM/DMARC lead time) | 2b production use | file transport in dev |
| Object storage provider | 5 production use | local disk in dev |
| **Who verifies legal content** (CDPA/POPIA/BDPA text, mappings) | 4 | ship NIST CSF + GDPR only; other frameworks as empty shells |
| Neon region vs data residency (CDPA/POPIA transfers) | production data | record in ADR-0004 |
| AI provider and per-organisation opt-in policy | 10 | feature off |
| Organisation provisioning (self-serve signup creates org + Owner, or platform-admin provisioned) | 2c | platform-admin provisioned |
| Confirm the **platform-admin flag** (ADR-0005) | 2c | assumed |
| Confirm `exposure_v1` default bands (only 4 of 125 input combinations reach Critical) | 5 | reference defaults |

## Phase details (backend)

### Phase 0 — foundation (this repository state)
- Endpoints: `GET /health`, `GET /health/ready`, `GET /meta`; Swagger UI `/api/docs`. Contract **0.1.0**.
- Infrastructure: validated env, problem+json filter, validation pipe, request id, helmet + CORS, pino, lazy Prisma adapter, OpenAPI export/check, docs check.
- Migrations: none. Tests: 30 unit + 13 e2e (no database).
- Spike S5 (Neon) was run in Phase 2a: [ADR-0001](adr/0001-toolchain-pins.md), [ADR-0004](adr/0004-tenancy-and-rls.md), [neon-setup.md](neon-setup.md) section 6.

### Phase 2a — database foundation ◆
- Neon `dev`/`test` branches wired; **spike S5 → RLS go/no-go** (ADR-0004); `GLOBAL_TABLES`; unit of work (`$transaction` + tenant `set_config`); `TenantRepository` base + Prisma `$extends` safety net; architecture test (only repositories import `PrismaService`).
- Migrations: `organisations` (with `timezone`), `users`, `memberships`, `audit_events` (append-only, `REVOKE` + trigger), `idempotency_keys`.
- Tenancy test harness (two organisations, fixtures, route walker), catalogue test, destructive-test guard, `test:int` script, `verify:full`.
- Exit: integration tests green on the Neon `test` branch; audit rows cannot be updated/deleted by the app role.

**What exists now (built 2026-10-15; verified on Neon the same day):**
- `prisma/schema.prisma` + migration `20261015000000_tenancy_foundation` (generated offline, plus hand-written checks and the audit append-only trigger): `organisations` (required `timezone`), `users` (lower-case email check), `memberships` (six-role enum, status), `audit_events`, `idempotency_keys`. The membership role is a Prisma enum for now; whether the planned `roles`/`role_permissions` tables are needed is decided in Phase 2c.
- `src/tenancy` (`RequestContext` + middleware), `src/database` (`catalogue.ts`, `tenant-guard.ts`, `db-client.ts`, `UnitOfWork`, `TenantRepository`), `src/audit` (service, insert-only repository, redaction, typed action catalogue), `PrismaService.db`, env `DATABASE_RLS_ENABLED` (default false).
- `prisma/sql/runtime-role.sql` (grants, audit privileges withheld, EXECUTE on the lookup functions). The row-level-security draft became migration `row_level_security` in Phase 2c.
- Tests: unit (tenant guard, request context, redaction, audit service, unit of work), `test/database/catalogue.spec.ts`, `test/architecture.spec.ts`, destructive-test guard, an e2e check of the request scope; integration specs `test/database/{tenant-safety-net,audit,runtime-role}.int-spec.ts` with `vitest.config.int.ts`, `test:int` and `verify:full`.
- Evidence: `npm run verify` green, and `npm run test:int` passes on Neon (49 of 49 with the 2b specs): the migrations, the append-only triggers, the privilege spec (`runtime-role.int-spec.ts`, as the non-owner `fca_app` on the pooled URL), the tenant safety net and the session-timezone spec. Spike S5 results are in [neon-setup.md](neon-setup.md) section 6; the RLS decision is in ADR-0004. An embedded PostgreSQL (PGlite) was used earlier only as a plumbing check and is not evidence.
- Setup that closed the phase: a `fca_test` database on the `test` branch and the `fca_app` role ([neon-setup.md](neon-setup.md)); both migrations applied to `neondb` (dev) and `fca_test`; `npm run db:apply-runtime-role` on both.
- Found on Neon and fixed in this phase: unreachable resolved addresses stalled new connections about 22 s (IPv4-first and a 2 s attempt timeout, `src/common/http/network.ts`); Prisma interactive transactions waited only 2 s for a connection (`UnitOfWork` now passes `maxWait`/`timeout` from env); a session in a non-UTC time zone silently shifts stored times (role-level `timezone = UTC`, a spec for it).
- Deferred on purpose: the idempotency service (the table exists; the code lands with the first create endpoint), the global `security_events` table (Phase 2b), `OrgContextGuard` (Phase 2c), the route walker for the tenancy matrix (needs tenant routes).

### Phase 2b — authentication and outbox ◆
- Endpoints: `POST /auth/register|login|refresh|logout`, `POST /auth/verify-email`, `POST /auth/forgot-password`, `POST /auth/reset-password`, `GET /me`.
- Migrations: `sessions` (family id), `auth_tokens` (hashed, purpose-typed), `login_attempts`, `jobs`, `scheduled_jobs`, `email_deliveries`.
- Infrastructure: argon2id, access JWT + rotating refresh cookie, throttler, `EmailProvider` (file transport), job runner + `POST /internal/jobs/tick`, global deny-by-default auth guard, `@Public()`.
- Exit: auth security tests (refresh reuse revokes family, single-use tokens, lockout, uniform responses), job tests (dedupe, retry, lease expiry).

**What exists now (backend, built 2026-10-15 without a Neon connection):**
- Migration `20261015120000_auth_and_jobs` (applied to `neondb` and `fca_test`): `users` gains `password_hash`, `email_verified_at`, `last_login_at`; new `sessions`, `refresh_tokens`, `auth_tokens`, `login_attempts`, `security_events` (append-only trigger), `jobs` (partial claim indexes), `email_deliveries`. Deviations from the list above: refresh tokens are their own table (reuse detection needs every token of a session); `scheduled_jobs` is deferred until the first recurring job.
- `src/auth` (service, controllers, guards, repositories, password/token/lockout rules), `src/security-events`, `src/jobs`, `src/mail`, `Clock`; contract **0.2.0**: eight `/auth/*` operations plus `GET /me` (`docs/integration.md`).
- Dependencies: `@nestjs/jwt` 12.0.3, `@nestjs/throttler` 6.7.1, `@node-rs/argon2` 2.2.2 (no install script, unlike `argon2`).
- Tests: unit (password policy, lockout, backoff, tick signature, templates, file transport, access token, cookies, CSRF guard, password service, job runner with fakes, `AuthService` with in-memory repositories incl. mutation-checked security properties, env schema), e2e without a database (deny by default, CSRF, cookie clearing, validation, tick authorisation, rate limiting before authentication, 503 on an unreachable database, every handler declares access), integration specs `test/auth/auth-flow.int-spec.ts`, `test/jobs/jobs.int-spec.ts`, `test/database/session-timezone.int-spec.ts`.
- Evidence: `npm run verify` green (255 unit, 42 e2e without a database, contract and docs checks); `npm run test:int` 49 of 49 on Neon. The frontend half (sign-up, confirm, sign-in, forgot/reset screens, session bootstrap, re-auth, route guards) is built in `fca-frontend`; its 8 Playwright journeys pass in Edge against this API on Neon (corrected: the run used the dev database as the owner role, see neon-setup.md section 6), reading the confirmation and reset links from the `.eml` files the file transport writes.
- Open: the platform needs a real email provider (gate G0) before production can send mail; `MAIL_TRANSPORT=file` only writes `.eml` files.

### Phase 2c — organisations, membership, RBAC ◆ (built)
**What exists (2026-10-16), backend:**
- `src/permissions/catalogue.ts`: 41 permission keys and the six role bundles, the single source of truth. `test/rbac-matrix-doc.spec.ts` parses [rbac-matrix.md](rbac-matrix.md) and fails if it differs. **Deviation from the plan:** roles and permissions are code, not tables (fixed system roles in v1), so there are no `roles` / `permissions` / `role_permissions` tables.
- `src/access`: one global `AccessGuard` (after `AuthGuard`) instead of separate `OrgContextGuard` and `PermissionGuard`: public / authenticated / platform flag / ACTIVE membership + permission, deny by default. Decorators `@RequirePermission`, `@OrganisationMember`, `@PlatformOnly` also write `x-access` / `x-permission` into the contract. `@Policy` (record-level rules) is deferred to Phase 5, the first module that needs one. Denials are logged, not stored (an audit row per 403 would let any member flood the append-only trail).
- `src/organisations`: organisations (self-serve creation behind `ORGANISATIONS_SELF_SERVE`, default off), members (list, change role, deactivate, reactivate; optimistic `version`; owner rules; last owner locked under concurrency), invitations (create, list, resend, revoke, inspect, accept; email job creates the token at send time). `src/platform`: provisioning and the names-and-counts list. `npm run platform-admin -- grant <email>` sets the flag (owner credentials).
- Migrations: `rbac_invitations` (`users.is_platform_admin`, `invitations` with a partial unique index, four SECURITY DEFINER lookup functions) and `row_level_security` (policy on every tenant table via `fca_enable_tenant_rls`, `organisations` included). `DATABASE_RLS_ENABLED` was removed: `UnitOfWork` always sets `app.org_id`.
- Tests on Neon: 67 integration tests before RLS (generated tenancy + RBAC matrices over every organisation route, the invitation flow, concurrency, platform provisioning), plus `rls.int-spec.ts`; unit tests for the guard, catalogue, services, UUIDv7, time zones.
- Not built (decided): organisation suspension (needs a status column and a guard branch; with Phase 3), `Idempotency-Key` on creates (no create endpoint yet where a duplicate is harmful and an organisation exists), per-denial audit rows.

**Original plan for this phase:**
- Endpoints: `POST /organisations`, `GET /organisations`, `…/members` (list, change role, deactivate), `…/invitations` (create, list, revoke, accept), `/platform/organisations` (platform admin).
- Migrations: `roles`, `permissions`, `role_permissions` (seeded catalogue), `invitations`, `users.is_platform_admin`.
- Infrastructure: `OrgContextGuard`, `PermissionGuard`, `@Policy`, catalogue → OpenAPI `x-permission`; **tenancy matrix + RBAC matrix generated tests**.
- Exit: every handler declares access (test); matrices green for all existing endpoints.

### Phase 3 — setup modules (built)
**What exists (2026-10-16), backend, contract 0.4.0 (20 operations, see [integration.md](integration.md)):**
- `src/settings`: company information (name, display name, legal name, registration number, sector, **country and DPO email required**, address, DPO name/phone, IANA `timezone`) with optimistic `version`, PATCH semantics (omit = keep, `null` or blank = clear), `company.branding` needed to change the display name; regulator contacts (separate from the DPO; several allowed); logo upload/serve/remove.
- `src/business-units`: name (unique among active units), code (unique per organisation, **archived units keep theirs**), description, head (an ACTIVE member), data sensitivity 1 to 5 (null = not classified, never defaulted), employee count, optional parent (must be active, no cycles, not itself). Units are **archived, never deleted**; archiving a unit that still has active children is refused (`409 BUSINESS_UNIT_HAS_CHILDREN`).
- `src/frameworks`: the catalogue (CDPA, POPIA, GDPR, BDPA, ISO 27701, NIST CSF; **identifiers only, no legal text**) and the organisation's chosen set (`PUT` the full set). Removing a framework keeps its history (the join row gets a `removed_at` time, it is not deleted).
- `src/plans` and `src/organisations/entitlements.*`, `src/organisations/subscription.controller.ts`, `src/platform`: four **placeholder** plans (Starter 5 users, Growth 15, Professional 25, Enterprise unlimited + API; limits are not commercially confirmed), `GET /subscription` (snapshot and usage), platform administrators list plans (including hidden ones), hide or show a plan, assign a plan to an organisation (the plan's limits are copied as a snapshot) and optionally pick a plan when provisioning. **No plan = no limits (never zero).** With a plan, inviting and reactivating are refused when active members plus open invitations would exceed the user limit (`403 USER_LIMIT_REACHED`).
- `src/storage`: `StorageProvider` + local driver (`STORAGE_LOCAL_DIR`, default `.local-storage`, git-ignored). Logos: PNG or JPEG up to 512 KiB, recognised by their bytes (no SVG), served only through an authorised endpoint with `ETag`, `nosniff` and a locked-down CSP. A logo change does **not** bump the organisation `version` (it is a separate resource).
- Migrations `…140000_setup_modules` (checks, partial unique indexes, RLS on the new tenant tables, seeds the six frameworks and four plans, recreates `fca_platform_organisations` with `plan_name`) and `…160000_company_sector_and_unit_fields` (sector; head, sensitivity, employees, parent with composite foreign keys; code unique including archived). The folder names carry hand-set times so that the helper functions of 2c exist first (`prisma migrate dev --create-only` stamps the UTC clock, which sorted before them: rename the folder).
- Seeded demo company for hand testing: `npm run seed:dev` ([neon-setup.md](neon-setup.md) section 7: accounts, password, what it creates).

**Deviations from the original plan (below), on purpose:**
- No `framework_versions` and no `deadline_policies` tables yet: they have no consumer before Phase 4 (versions and content) and Phase 7 (deadline policy). The catalogue holds identifiers only.
- No `@RequireEntitlement` decorator: the only enforced limit (users) is checked directly inside the invite and reactivate transactions. The decorator arrives with the first feature entitlement (Phase 8 and later).
- The subscription **page** is Phase 10 (the endpoint exists; the frontend shows nothing for it yet beyond the platform plan pages).
- "Reassign" is moot until records point at business units (Phase 5 and later); only archive exists. The "linked records block deletion" criterion is met by never deleting.
- The logo is stored and served but the app shell does not display it yet.
- **No new automated tests** (see the status row). The existing suites and the generated tenancy + RBAC matrix cover the new routes' access rules; behaviour rules (limits, cycles, archive, logo checks, field requirements) are **not** covered by a permanent test.

**Original plan for this phase:**
- Endpoints: `GET/PATCH …/settings` (company information, DPO and regulator contacts, `timezone`), logo upload/download, `…/business-units` (CRUD, archive/reassign), `…/frameworks` (applicable frameworks), `GET /frameworks`, `GET /plans`, `…/subscription`, `/platform/plans` (visibility).
- Migrations: organisation settings columns, `business_units`, `frameworks`, `framework_versions`, `organisation_frameworks`, `plans`, `plan_visibility`, `organisation_entitlements`, `deadline_policies` (empty).
- ◆ `StorageProvider` abstraction + local driver (logo) and `@RequireEntitlement`.
- Exit: changing frameworks never deletes history; hiding a plan never revokes entitlements (tests).

### Phase 4 — compliance mapping and content (built; content waits for verification)
**What exists (2026-10-16), backend, contract 0.5.0 (15 operations, see [integration.md](integration.md)):**
- Migration `20261016180000_compliance_mapping`: `framework_versions` (status, licence class, source URL and citation, retrieval time, `source_hash` of the stored source file, `content_hash` of what was reviewed, verifier and time), `requirements` (tree by composite foreign key inside one version: identifier, kind, title, description, `text_source`), `mapping_pack_entries` (default mappings that come from a CITED crosswalk), and the tenant tables `governance_areas` and `organisation_mappings` (RLS on). Hand-written: checks (a verified version needs a named verifier; a seed mapping points at its pack entry; a user mapping needs a rationale), partial unique indexes (area name among active areas; one active mapping per pair; **one copy of a pack entry per organisation in any state**, so Load Default Mappings never duplicates and never resurrects an archived row), and **immutability triggers**: a version beyond DRAFT, its requirements and its pack entries cannot be updated or deleted (only the status may move forward). `prisma/sql/runtime-role.sql` withholds INSERT/UPDATE/DELETE on the three global tables from `fca_app`: only the owner-run loader writes them.
- `src/governance-areas` (the rows of the mapping table; the organisation's OWN labels, none are shipped; archived, never deleted), `src/compliance-mappings` (list, get, create, update, archive/unarchive, the matrix, Load Default Mappings), `src/frameworks` (reference guide with provenance, requirement lists). Permissions are the existing `mapping.view`, `mapping.edit`, `mapping.loadDefaults` (areas use `mapping.*` too; no new keys).
- Rules enforced in the service: a mapping links requirements of two DIFFERENT frameworks that both belong to a loaded, verified version; the same pair cannot be mapped twice among active mappings (either direction); a mapping filed under an area needs an active area; a mapping copied from the pack can only change its area and review status; archived areas that still hold mappings stay visible in the matrix (flagged), so archiving an area never hides a mapping.
- Load Default Mappings: one transaction; applicable frameworks only; `createMany` with `skipDuplicates` (ON CONFLICT DO NOTHING); returns `{ inserted, skipped, failed, frameworks }` (`failed` is empty today because one set-based insert cannot fail per row: a database error rolls everything back); `422 SEED_DATA_UNAVAILABLE` with zero writes when no verified pack exists, `422 NO_FRAMEWORKS_SELECTED` when none is applicable; audited as `mapping.defaults_loaded`.
- **Content tooling** (`scripts/frameworks/`, npm `frameworks:status|extract|verify|load`): `extract` parses a stored primary source into `prisma/seed-data/<framework>/<version>/pack.json` (a DRAFT); `verify -- <pack> --by "Full Name"` is the act of a named person stating they compared the pack with the source; `load` (owner credentials, `DIRECT_URL`) loads only verified packs whose content still matches the verified hash and whose stored source file is unchanged. Extracted so far (drafts): **NIST CSF 2.0** from the official CSF 2.0 Reference Tool export (6 functions, 22 categories, 106 subcategories: the published structure; 91 withdrawn CSF 1.1 entries in the export were excluded mechanically) and the **GDPR** from the English Official Journal text of the EU Publications Office (11 chapters, 99 articles; identifiers and headings only, never the operative text). Both carry source URL, retrieval time and SHA-256 of the stored file; see [frameworks/source-registry.md](frameworks/source-registry.md).
- **No default mappings are shipped**: the plan requires a cited crosswalk or a named legal reviewer and none was supplied, so every pack has `mappings: []` and Load Default Mappings answers 422 until one is. CDPA, POPIA, BDPA and ISO 27701 have no pack (shells), by design.

**Deviations from the original plan (below), on purpose:**
- `GET /frameworks/:id/versions` became `GET /frameworks/reference-guide` (every framework with its versions in one call) plus `GET /framework-versions/{versionId}/requirements`.
- A new tenant entity, `governance_areas`, was added because the spec's mapping table is "Governance Area × frameworks" and nothing else defines an area before Phase 5. It is a plain label list owned by the organisation; Phase 5 assessments will point at it (revisit if Phase 5 needs more).
- No audit-history endpoint for a mapping: every change is audited (`mapping.*`), the Audit Trail UI is Phase 9a.
- No server-side sorting of the table (cursor order = creation order), as in the other lists.
- **No new automated tests.** The existing generated tenancy and RBAC matrices cover the new routes' access rules; `test:int` was not re-run (the test database is no longer used).

**Original plan for this phase:**
- Endpoints: `GET /frameworks/:id/versions`, `…/compliance-mappings` (list, create, update, archive), `POST …/compliance-mappings/load-defaults`, framework reference guide.
- Migrations: `requirements`, `mapping_pack_entries`, `organisation_mappings`.
- Content track (human verification): NIST CSF 2.0 Core and GDPR from official sources with provenance; other frameworks as shells until the owner supplies/approves text.
- Exit: Load Default Mappings idempotent, transactional, audited, returns inserted/skipped/failed; `422 SEED_DATA_UNAVAILABLE` with no writes when nothing verified.

### Phase 5 — governance assessment
- Endpoints: `…/assessment-templates` (versioned), `…/assessments` (+ items, submit, approve, history), `…/remediation-tasks` (generate from gaps, comments, status transitions, verify, reopen), `…/priority-matrix` (counts, items, adjust with reason).
- Domain: `src/domain/scoring` (methodologies, bands, roll-ups), Eisenhower rule v1; metric definitions + golden tests for assessment metrics.
- ◆ Evidence core (upload/link/download, checksum, local driver) and Report core (pdfmake, `reports` record, one template: Governance Assessment) so evidence linking and Export PDF are real.
- Exit: unassessed never defaulted; approved assessments immutable; scoring boundary tests.

### Phase 6 — registers
- Endpoints: risk register (inherent/residual, treatment, acceptance history), data classification levels, lawful basis, RoPA (+ review history), retention rules (+ legal holds, disposal tracking).
- Exit: each register has metrics and golden tests; legal hold blocks disposal everywhere.

### Phase 7 — incidents and rights
- Endpoints: DSAR (lifecycle, communications, extensions under policy, closure evidence), breaches (chronology, notification decisions, deadlines under policy), evidence repository (browse, versions, review, legal hold, virus-scan state), reminders (upcoming/overdue, assignment, preferences, delivery status).
- Exit: overdue alerts via outbox are idempotent; DSAR SLA metric distinguishes completed-in-SLA from not-yet-due.

### Phase 8 — executive dashboard
- Endpoints: `GET …/dashboard/summary` (sections with availability/status/coverage), lazy endpoints for heatmap (+ drill-down), comparison (bar/radar/table), gap analysis, RoPA monitor, priority quadrants, top high-risk areas; `POST …/dashboard/ai-assessment` placeholder gated until Phase 10.
- Exit: every metric has a definition sheet entry and golden tests (empty, partial, full); dashboard uses set-based queries, not per-card fan-out.

### Phase 9 — reports, audit, training, manual
- 9a: report catalogue + history, remaining templates, audit trail search/export. 9b: training (courses, lessons, quiz grading **server-side**, enrolments, assignments, certificates). 9c: user manual (frontend-bundled content; no backend beyond optional search index).

### Phase 10 — AI and entitlements UI
- `POST …/ai/risk-assessments` (async, per-organisation opt-in, entitlement-gated, minimised inputs, audited, results stored with sources and timestamp), subscription/entitlement endpoints complete, optional integrations.

### Phase 11 — release readiness
- End-to-end tests (Playwright in the frontend against this API), security review (OWASP ASVS pass), accessibility review, load/cold-start checks on Neon, deployment validation, backup/restore drill, release documentation.

## Contract-version ledger
| Version | Phase | Change |
|---|---|---|
| 0.1.0 | 0 | `/health`, `/health/ready`, `/meta`, problem+json model |
| 0.2.0 | 2b | `/auth/*` (register, resend-verification, verify-email, login, refresh, logout, forgot-password, reset-password), `GET /me`; error codes `INVALID_CREDENTIALS`, `EMAIL_NOT_VERIFIED`, `INVALID_TOKEN` |
| 0.3.0 | 2c | organisations, members, invitations, platform provisioning; `x-access` / `x-permission` on every operation; `GET /me` gains `isPlatformAdmin`, `GET /meta` gains `organisationSelfServe` |
| 0.4.0 | 3 | settings (company information, regulator contacts, logo), business units, framework catalogue and selection, plans, subscription, platform plan visibility and assignment; error codes `BUSINESS_UNIT_NAME_TAKEN`, `BUSINESS_UNIT_CODE_TAKEN`, `BUSINESS_UNIT_HAS_CHILDREN`, `USER_LIMIT_REACHED` |
| 0.5.0 | 4 | framework reference guide and requirement lists, governance areas, compliance mappings (list, matrix, create, update, archive), Load Default Mappings; error codes `GOVERNANCE_AREA_NAME_TAKEN`, `MAPPING_ALREADY_EXISTS`, `SEED_DATA_UNAVAILABLE`, `NO_FRAMEWORKS_SELECTED` |
