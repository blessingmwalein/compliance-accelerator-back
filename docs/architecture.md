# fca-backend architecture

Status: **Phase 0 foundation implemented; everything else specified here is the target** (sections marked *Phase N* are built in that phase). Decisions are recorded in [docs/adr](adr/); rules for working in each area are in `.claude/skills/`.

## 1. Scope and pins
Multi-tenant REST API for the FCA GRC platform. Node 24, TypeScript 6.0.3, NestJS 12.1 (ESM), Prisma 7.10 + `@prisma/adapter-pg`, PostgreSQL on Neon, Vitest 4.1, oxlint. Exact pins and spike results: [ADR-0001](adr/0001-toolchain-pins.md). The frontend is a separate repository; the contract between them is [contracts/openapi.json](../contracts/openapi.json) ([ADR-0002](adr/0002-repo-and-contract-strategy.md)).

## 2. Module map
```
src/
  common/      filters (problem+json), pipes (validation), http (request id, OpenAPI helpers, configure-app), errors
  config/      validated environment (fail fast)
  prisma/      PrismaService (adapter-pg, lazy): `db` is the tenant-checked client      [built]
  tenancy/     RequestContext (AsyncLocalStorage: request id, actor, tenant) + middleware [built, 2a]
  database/    tenancy catalogue (TENANT_MODELS, GLOBAL_TABLES), tenant guard, UnitOfWork, TenantRepository [built, 2a]
  audit/       AuditService (same-transaction, fail-closed), AuditRepository (insert-only), redaction [built, 2a]
  health/ meta/   liveness/readiness, build + contract version                      [Phase 0]
  auth/        register, verify, login, refresh, logout, reset, /me; AuthGuard; password, token, lockout rules [built, 2b]
  security-events/  append-only events with no organisation (login, refresh reuse, reset)       [built, 2b]
  jobs/ mail/  outbox + lease runner + tick endpoint + poller; EmailProvider, file transport, templates [built, 2b]
  access/ organisations/ permissions/ platform/                                        [Phase 2c, built]
  audit-trail/ notifications/ storage/                                                [Phase 9a/5]
  frameworks/ controls/ compliance-mapping/                                           [Phase 3/4]
  business-units/ company-settings (organisations)/                                   [Phase 3]
  governance-assessment/ eisenhower-matrix/ remediation/                              [Phase 5]
  risk-register/ data-classification/ lawful-basis/ ropa/ retention/                  [Phase 6]
  dsar/ breaches/ evidence/ reminders/                                                [Phase 7]
  dashboard/                                                                          [Phase 8]
  reports/ training/ user-manual (frontend content)/                                  [Phase 9]
  ai-risk-assessment/ subscriptions/                                                  [Phase 10]
  domain/      pure scoring, roll-ups, state machines, metric states (no Nest, no Prisma)   [Phase 5+]
  cli/         export-openapi
```
Each feature module follows one template: `<x>.controller.ts`, `<x>.service.ts`, `<x>.repository.ts`, `dto/*.dto.ts`, `<x>.policy.ts` (record rules), `<x>.module.ts`, specs.

## 3. Layering rules
`controller → service → repository → PrismaService`, plus `service → domain`. Controllers do HTTP only; services own rules, transactions and audit; **only repositories import `PrismaService`** (health probes excepted); `domain/` has no framework imports. Cross-module calls go service to service. An architecture test (added with the first real module) enforces the import rules. See `backend-architecture`.

## 4. Request pipeline (order is part of the contract)
1. `pino-http` assigns/propagates `X-Request-Id` (inbound ids are accepted only if they match `^[A-Za-z0-9._-]{8,64}$`) and redacts `authorization`, `cookie`, `set-cookie` in logs. **[done]**
2. `helmet`, then exact-origin CORS with credentials (`CORS_ORIGINS`), exposing `X-Request-Id`. **[done]** (Swagger is mounted before helmet so its UI works; docs are off by default in production.)
3. `@nestjs/throttler` coarse per-IP limit (`THROTTLE_LIMIT`, stricter `@Throttle` on the auth routes), registered **before** the auth guard so a flood is cut before any database work. **[done, 2b]**
4. Body parsing (malformed JSON becomes a 400 problem).
5. `AuthGuard`, **deny by default** (`@Public()` opts out, `@Authenticated()` = any signed-in user): verifies the access JWT, then re-reads the session from the database on every request. **[done, 2b]**
6. `AccessGuard` (global, right after `AuthGuard`; **built in 2c**) resolves the caller's ACTIVE membership of `:organisationId` through a SECURITY DEFINER lookup (404 for a non-member, a deactivated member and an unknown organisation alike), checks the role against the permission catalogue (403 before anything is looked up) and only then writes organisation, membership and role to the request scope (`RequestContext.update`). `@PlatformOnly` routes check the platform-admin flag instead; a handler with no declaration is denied. `test/organisations/access-matrix.int-spec.ts` proves the order and the outcomes for every organisation route.
7. Entitlements (`@RequireEntitlement`) arrive with the plan tables in Phase 3.
8. Global `ValidationPipe` (whitelist, forbid unknown, transform). **[done]**
9. Handler → service → repository.
10. Serialisation interceptors; `ProblemDetailsFilter` renders **every** error as `application/problem+json`. **[done]**

## 5. Tenancy (see [ADR-0004](adr/0004-tenancy-and-rls.md), `database-and-tenancy`)
Routes `/api/v1/organisations/:organisationId/…`; `AccessGuard` (**built**, 2c) → `RequestContext` (AsyncLocalStorage, **built**) → tenant-scoped repositories extending `TenantRepository` (no bare-id methods, **built**) → Prisma `$extends` safety net `assertTenantScoped` (asserts `organisationId` on every tenant-model query and fails closed, **built**) → composite foreign keys (rule enforced by the catalogue test, **built**; no tenant-to-tenant relation exists yet) → **row-level security** (**built and ON since 2c**, migration `row_level_security`: every tenant table has a `tenant_isolation` policy on `app.org_id`, set by `UnitOfWork` as the first statement of each transaction, transaction-local so safe behind PgBouncer; fails closed; the few reads that happen before a tenant is known use SECURITY DEFINER functions; `test/database/rls.int-spec.ts`). Foreign or unknown records are 404. `test/database/catalogue.spec.ts` parses `prisma/schema.prisma` and fails the build if a table is neither tenant-owned (`TENANT_MODELS`), global (`GLOBAL_TABLES`, with a reason) nor the root; `test/architecture.spec.ts` confines Prisma and raw SQL to repositories and infrastructure. Both are proven to fail on planted violations.

## 6. Data conventions
UUID primary keys (v7 if supported); `timestamptz` instants; `date` business dates; `snake_case` columns; `version` integer for optimistic concurrency; soft delete only where legally or audit-relevant; per-organisation unique keys; every tenant table indexed on `organisation_id` first; **raw inputs stored, derived values computed** (snapshots carry methodology and band versions); unassessed is `NULL`. Cursor pagination (`limit` default 25, max 100), allow-listed sort and filter fields, `Idempotency-Key` on creates.

## 7. Authentication and authorisation (see ADR-0003, ADR-0005, `security-and-rbac`) *[authentication built in 2b; roles, permissions, organisations, members and invitations built in 2c]*
**Built (2b):** `POST /auth/register|resend-verification|verify-email|login|refresh|logout|forgot-password|reset-password` and `GET /me` (contract 0.2.0). 15-minute HS256 access JWT with only `sub` and `sid`; opaque 32-byte refresh token in an HttpOnly `SameSite=Lax` cookie scoped to `/api/v1/auth`, stored as SHA-256, **rotated on every use**; presenting a used token again revokes the whole session unless it happens within a 10-second grace window (several tabs restoring at once). Sessions have an absolute 30-day lifetime. argon2id (`@node-rs/argon2`). Verification and reset tokens are random 32 bytes, stored hashed, single use, 24 h / 30 min, created by the email job at send time and delivered in the **URL fragment**; consumed by POST. Login lockout is Postgres-backed (5 failures per account or 30 per IP in 15 minutes, then 30 s doubling to 15 min, `Retry-After`) and keyed on **keyed hashes** of the address and IP, so unknown addresses lock exactly like real ones. Registration, resend and forgot-password answer 202 whatever the account state; a wrong password and an unknown address are the same 401 and both pay for an argon2 verification. A password reset ends every session. Cookie endpoints also need `X-Requested-With: fca-web` and an allowed Origin. Every outcome that matters writes a `security_events` row.

**Built (2c):** the typed permission catalogue and six role bundles (`src/permissions/catalogue.ts`, checked against [rbac-matrix.md](rbac-matrix.md) by a test), the global `AccessGuard`, `GET /organisations`, `POST /organisations` (self-serve, off by default), `GET /organisations/:id/me` (role + permissions), members (list, change role, deactivate, reactivate), invitations (create, list, resend, revoke, inspect, accept; the email job creates the one-time token at send time), platform provisioning (`/platform/organisations`, platform-admin flag granted only by `npm run platform-admin`), cursor pagination, optimistic locking (`version`), the last-owner rule under concurrency, and RLS.

**Still to come:** MFA (reserved), entitlements and plan visibility (3), record-level `@Policy` rules (with the first module that needs one, Phase 5), organisation suspension. Principles: Six fixed roles (Company Owner, Company Admin, Compliance Manager, Course Administrator, Standard User, Read Only) as bundles of `module.action` permissions ([rbac-matrix.md](rbac-matrix.md)); DPO is a designated contact, not a role; a platform-admin flag (assumption) is confined to `/platform/*`.

## 8. Audit *[write side built in Phase 2a, UI Phase 9a]*
Implemented: `UnitOfWork.run(tx => …)` + `AuditService.record(tx, { action, entityType, entityId?, entityLabel?, outcome?, changes? })`. Actor and request id come from `RequestContext`, the organisation from the verified tenant, the time from the database; `changes` goes through `redactChanges` (secrets only: callers still pass field-level before/after values, never DSAR or breach free text). The migration adds a trigger that rejects UPDATE and DELETE for every role; `prisma/sql/runtime-role.sql` also withholds the privileges from the runtime role. `audit_events.organisation_id` is mandatory, so events that belong to no organisation (login attempts, platform actions) need a separate global `security_events` table, planned for Phase 2b. Deleting an organisation that has audit events is blocked (`ON DELETE RESTRICT`): tenant offboarding is an open concern to design before production.

`audit_events` (tenant scoped, append-only): `occurred_at` (server clock), actor, action (typed catalogue), entity type/id/name, `changes` (JSONB, sensitive fields redacted), request id, outcome. Written **inside the same transaction** as the change and **fail-closed**. Immutability is enforced in the database (`REVOKE UPDATE, DELETE` for the app role + trigger) so ordinary users and the app role cannot alter history. The legacy client-side, swallowed, client-timestamped audit log is the anti-pattern.

## 9. Error contract (**implemented**)
RFC 9457 `application/problem+json`: `{ type: "urn:fca:problem:<code>", title, status, detail?, code, errors?: [{ path, code, message? }], requestId }`. Stable codes live in `ErrorCode` (`VALIDATION_FAILED`, `NOT_FOUND`, `FORBIDDEN`, `CONFLICT`, `DATABASE_UNAVAILABLE`, …). Unexpected errors return a generic 500 and are logged with the request id; internals never leak. Documented per endpoint via `@ApiProblemResponse`.

## 10. Scoring and metrics (see `grc-domain`, [metrics](metrics/README.md)) *[Phase 5+]*
Pure `src/domain/scoring`: versioned `Methodology` (`exposure_v1`, `risk_matrix_v1`, `maturity_v1`), `exposure/gap/bandFor/rollUp`, unassessed = `null`, aggregates return coverage. Metric states are `availability` × `status`. Each module ships its metric definition and golden tests from Phase 5; the dashboard (Phase 8) composes them: `GET …/dashboard/summary` returns per-section states so one failure never blanks the page; heavy widgets are lazy endpoints; one set-based SQL per section.

## 11. Jobs, email, notifications (ADR-0006, `notifications-and-jobs`) *[outbox and email built in 2b, notifications later]*
**Built (2b):** `jobs` table, `JobsService.enqueue(job, tx)` (deterministic `dedupeKey`, `ON CONFLICT DO NOTHING`), `JobRunner.runBatch` (claim with `FOR UPDATE SKIP LOCKED`, lease, exponential backoff with jitter, dead letters, lease-expiry reclaim and dead-lettering on the last attempt, per-job failure isolation, tenant jobs run inside their organisation scope), handlers found by `@JobHandler(type)` scanning, `POST /internal/jobs/tick` (HMAC-SHA256 over `timestamp.POST.path`, 5-minute window, 404 when no secret, excluded from OpenAPI) and an in-process poller (`JOBS_RUNNER=inproc`, backs off when the database is down). Email: `EmailProvider`, `FileMailTransport` (writes `.eml` to `DEV_MAIL_DIR`, nothing is delivered), link-only templates with escaping and an http(s)-only link check, one `email_deliveries` row per attempt keyed on the address. `scheduled_jobs` (recurring definitions) is deferred to the first recurring job (Phase 7 reminders). SMTP/ESP waits for gate G0.

Design: outbox + lease runner (`FOR UPDATE SKIP LOCKED`), in-process poller or HMAC-signed `POST /internal/jobs/tick`, idempotent handlers with deterministic dedupe keys, `EmailProvider` (file transport in dev), `email_deliveries` keyed on address, in-app `notifications`.

## 12. Storage and evidence (ADR-0007) *[core Phase 5, full Phase 7]*
`StorageProvider` (local/S3), opaque keys, proxied downloads with audit, magic-byte validation, SHA-256, `VirusScanner`, legal-hold-aware disposal.

## 13. Reports (ADR-0008, `reports-and-documents`) *[core Phase 5, catalogue Phase 9a]*
Server-side pdfmake, stored `report` records with data snapshots, SVG charts, embedded fonts, async via jobs.

## 14. Framework content (ADR-0009, `compliance-frameworks`) *[Phase 3/4]*
Versioned frameworks, requirements, mapping packs with provenance; only `verified` content loads; deadline policies are data.

## 15. Configuration, logging, observability
Validated environment (`src/config/env.schema.ts`), `.env.example` is the documentation (CI check). pino JSON logs with request ids; no bodies or personal data. `GET /health` (liveness), `GET /health/ready` (database `SELECT 1`, 503 problem+json otherwise), `GET /meta` (build and contract version). Metrics/tracing: decide at the hosting gate.

## 16. Deployment options (decide at gate G0)
| Option | Fits | Notes |
|---|---|---|
| Always-on container host (Render/Fly/Railway/VM) | in-process job poller, local-disk-free storage via S3 | simplest; same-site domains via custom domain |
| Serverless functions | external job tick, pre-signed uploads | body limits, cold starts, cookie scope need care |
Common: HTTPS, same-site custom domains for web and API, secrets in the host's secret store, Neon `main` for production with PITR, separate roles for runtime and migrations.

## 17. Concerns the specification does not cover (to be decided; tracked here)
Tenant offboarding, export and deletion (right to erasure for the *platform's* own customers) · backups and point-in-time recovery vs deletion obligations · data residency (Neon region vs transfer rules) · field-level encryption for DSAR and breach personal data · rate limits per organisation · CSV import/export · WCAG target (2.2 AA assumed) · observability stack · incident response for the platform itself.

## 18. Decision index
[0001 toolchain](adr/0001-toolchain-pins.md) · [0002 contract](adr/0002-repo-and-contract-strategy.md) · [0003 auth](adr/0003-auth-and-session.md) · [0004 tenancy/RLS](adr/0004-tenancy-and-rls.md) · [0005 RBAC](adr/0005-rbac.md) · [0006 jobs](adr/0006-jobs-and-notifications.md) · [0007 storage](adr/0007-evidence-storage.md) · [0008 reports](adr/0008-reports-and-pdf.md) · [0009 frameworks](adr/0009-framework-content-and-provenance.md)
