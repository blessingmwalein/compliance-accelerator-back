# ADR-0004: Tenancy model and Row-Level Security

- **Status:** Accepted; spike S5 passed on Neon (2026-10-15); **RLS (layer 5) is ON since Phase 2c** (migration `row_level_security`)
- **Date:** 2026-10-14

## Context
Every customer is an organisation. A single cross-tenant leak in a compliance product is a severe incident. The legacy app had no tenant scoping at all (unscoped `list()` calls, `Company.list()[0]`).

## Decision
- **Path-scoped routes**: `/api/v1/organisations/:organisationId/…`. RTK Query cache keys therefore carry the organisation (no bleed on switch). Non-tenant routes: `/auth`, `/me`, catalogues, `/platform`. Header- or claim-based tenancy was rejected (omittable or stale).
- **Layers, in order**: (1) `OrgContextGuard` verifies an active membership and stores `TenantContext` in AsyncLocalStorage; (2) `TenantRepository` base with no bare-id methods (only repositories may import `PrismaService`; enforced by an architecture test); (3) a Prisma `$extends` safety net that asserts or injects `organisationId`; (4) composite foreign keys `(organisation_id, parent_id)`; (5) **Postgres RLS backstop**: `ENABLE` + `FORCE ROW LEVEL SECURITY`, policy on `current_setting('app.org_id', true)`, set per request via `set_config('app.org_id', …, true)` **inside the request transaction** (pooler-safe), runtime role without `BYPASSRLS` and not the table owner, migrations as owner on the direct URL, fail-closed when unset.
- A foreign or unknown record returns **404**; a member lacking permission gets **403** before any lookup.
- A catalogue test fails the build if a table has neither `organisation_id` nor an entry in `GLOBAL_TABLES`.

## RLS go/no-go (decided before Phase 2a)
Spike S5 on Neon must show that a pooled-URL interactive transaction with `set_config` works through PgBouncer, that the per-request transaction overhead is acceptable, and that the non-owner role and grants work with Prisma migrations. If it passes, ship layer 5. If not, ship layers 1 to 4, record the residual risk here and keep the tenancy matrix tests as the primary control.

## Phase 2a outcome (2026-10-15)
- **Layers 1 to 4 are built and tested** (the guard is wired through the request scope; tests need no database): `RequestContext`, `TenantRepository`, the Prisma `$extends` safety net (`assertTenantScoped`: asserts `organisationId` on every tenant-model query, rejects bare-id lookups, unknown operations and any query outside a verified tenant scope), the catalogue test and the composite-FK convention check. The safety net also runs inside interactive transactions. Raw SQL is not covered by it, so it is confined to repositories and infrastructure by the architecture test.
- **Layer 5 (RLS) is built and ON (Phase 2c)**: migration `row_level_security` gives every tenant table (and the root `organisations`, keyed on `id`) one `tenant_isolation` policy via the owner-only helper `fca_enable_tenant_rls(table, column)`; a migration that adds a tenant table calls it, and `test/database/rls.int-spec.ts` fails for a table with `organisation_id` and no policy. `UnitOfWork` sets `app.org_id` as the first statement of every transaction that has a verified tenant (`DATABASE_RLS_ENABLED` was removed: always on).
- **Pre-tenant reads (the known cost, resolved):** the access guard (is this user a member of this organisation), `GET /organisations`, the invitation lookup by token hash and the platform list cannot be ordinary tenant queries. Each is a `SECURITY DEFINER` function with a fixed `search_path` (`fca_membership_of`, `fca_memberships_of_user`, `fca_invitation_by_token`, `fca_platform_organisations`) taking only server-verified values and returning only the caller's own rows; `EXECUTE` is granted to the runtime role in `prisma/sql/runtime-role.sql`. They run as the owner, which on Neon has `BYPASSRLS` (on a host where the owner lacks it, `FORCE` would bind the functions too: revisit if the host changes).
- **Trap found while testing**: Prisma queries are lazy thenables and run the safety net when first awaited, so a query returned un-awaited from a request-scope callback started outside the scope and failed with `TENANT_CONTEXT_MISSING` (fail closed, but confusing). `RequestContext.run` now starts any returned thenable inside the scope, and services must still `await` queries.

## Spike S5 outcome on Neon (2026-10-15) and the go/no-go
Measured on Neon PostgreSQL 18.6, database `fca_test`, pooled URL (PgBouncer, transaction mode), runtime role `fca_app` (not the owner, no `BYPASSRLS`); the owner role `neondb_owner` has `BYPASSRLS`, which is why migrations, resets and fixtures keep working with RLS on:
- `SELECT set_config('app.org_id', $1, true)` inside an interactive transaction is visible to the next statement of the same transaction and is **absent afterwards** (12 later reads on pooled connections: no leak); 12 concurrent transactions for two tenants each saw only their own value.
- With `rls.sql` applied: no setting gives 0 rows (fail-closed), a tenant sees only its own rows, a cross-tenant `INSERT` is rejected by `WITH CHECK`, the owner role bypasses the policies. The policies were removed again after the probe.
- Cost: one extra statement per request transaction, i.e. one round trip (about 300 ms from the development machine to `us-east-2`; set-based statements and a short transaction keep this tolerable).
- `migrate deploy` on the direct URL and the shadow database work.

**Decision: go, adopted in Phase 2c (done).** Consequences that follow from it: every service reads and writes tenant data inside `uow.run` (a bare tenant query sees nothing, it does not error); tenant repository methods take `tx`; each request pays one extra round trip (the `set_config`); creating an organisation sets the new id as the tenant of its own transaction (the id is generated up front, UUIDv7). Residual risk: raw SQL is not covered by the Prisma safety net (confined to repositories by the architecture test), and the policies protect only what has `organisation_id`.

## Consequences
RLS costs a transaction per request and needs two database roles; raw SQL and new repositories are where leaks appear (hence the tests). Schema-per-tenant and database-per-tenant were rejected (migration fan-out, branch limits).

## Data residency
The Neon region is a legal decision (CDPA and POPIA cross-border transfer rules). Choose it consciously and record it here before production data is loaded: **region: TBD (gate G0)**. For information, the development project currently runs in `us-east-2` (Ohio); that is a development convenience, not a residency decision, and from the development machine it costs about 300 ms per query round trip.

## Revisit when
The host changes (owner without `BYPASSRLS`), or a customer requires dedicated databases.
