# Neon setup (database for development, tests and production)

The project uses **Neon** (serverless PostgreSQL) for everything: there is no local Postgres or Docker requirement. The API runs without a database (health, meta and docs work); anything database-backed needs the connection strings below.

> **Security:** put connection strings only in the git-ignored `.env`. Never paste them into chat, tickets or commits. Rotate a password immediately if it leaks.

## 1. Create the project and branches
1. Create a Neon project (for example `fca`). **Choose the region deliberately**: it determines where personal data is stored and therefore which cross-border transfer rules (CDPA, POPIA, GDPR) apply. Record the choice in [ADR-0004](adr/0004-tenancy-and-rls.md).
2. Keep the default branch (`main`) **reserved for production**; do not develop on it.
3. Create two child branches: **`dev`** (daily development, `prisma migrate dev`) and **`test`** (integration tests; destructive, reset at will).

## 2. Copy the connection strings (per branch)
Neon shows two hosts per branch:
- **Pooled** (host contains `-pooler`): PgBouncer in transaction mode. Used by the running app.
- **Direct** (no `-pooler`): used by the Prisma CLI for migrations.

Both include `sslmode=require`. In `fca-backend/.env`:

| Variable | Value |
|---|---|
| `DATABASE_URL` | `dev` branch, **pooled** |
| `DIRECT_URL` | `dev` branch, **direct** |
| `TEST_DATABASE_URL` | `test` branch, **pooled** (integration tests; name must contain `test`) |
| `TEST_DIRECT_URL` | `test` branch, **direct** |
| `ALLOW_DESTRUCTIVE_TESTS` | `true` only on the machine that runs integration tests |

## 3. Verify
```powershell
npm run start:dev
curl http://localhost:3001/api/v1/health/ready      # 200 {"status":"ok","checks":{"database":"up"}}
```
`503 DATABASE_NOT_CONFIGURED` means `DATABASE_URL` is empty; `503 DATABASE_UNAVAILABLE` means it is set but unreachable (see cold starts below).

## 4. Migrations (from Phase 2a)
- Eleven migrations exist (`20261015000000_tenancy_foundation`, `20261015120000_auth_and_jobs`, `20261016083931_rbac_invitations`, `20261016120000_row_level_security`, `20261016140000_setup_modules`, `20261016160000_company_sector_and_unit_fields`, `20261016180000_compliance_mapping`, `20261016200000_assessment_scoring_remediation`, `20261016220000_assessment_templates`, `20261017120000_phase6_registers`, `20261017180000_phase7_incidents_rights`). **All eleven are applied to the dev database** (the last three on 2026-10-18, with `npm run db:apply-runtime-role` re-applied straight after). One open item from the templates seed: `prisma migrate deploy` applies every pending migration at once, so `20261016220000_assessment_templates` went in while its seeded `verified_by` still held the `<VERIFYING-PERSON-NAME>` placeholder — the two template rows are readable and the assessment templates dialog prints that placeholder in its "wording checked by" line, so the owner's real verifier name has to replace it with a data migration before any of that is shown outside dev. `npm run db:status` is the check. Apply new ones with `npm run db:migrate:deploy`.
- New migrations: develop on `dev` with `npm run db:migrate:dev -- --create-only` (the CLI uses `DIRECT_URL` and needs permission to create a shadow database), review the SQL, append hand-written SQL (CHECK constraints, triggers) **before** the first apply, then apply.
- Apply elsewhere: `npm run db:migrate:deploy`. Check state: `npm run db:status`.
- Never edit an applied migration; fix forward.
- Offline SQL generation: `prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script` prints nothing unless `DIRECT_URL` is set to any syntactically valid URL (it only needs the provider).

### The test database
Neon's default database is called `neondb` on **every** branch, and the destructive-test guard refuses any database whose name does not contain `test`. On the `test` branch create a database named `fca_test` (Neon console → branch → Databases) and put it in both `TEST_DATABASE_URL` and `TEST_DIRECT_URL` (the guard also checks that both name the same database and endpoint, and that neither equals `DATABASE_URL`/`DIRECT_URL`). `npm run test:int` migrates and empties that database every run.

### Runtime role (before `test:int` can pass)
The application must **not** connect as the table owner:
1. Create a login role `fca_app` on each branch that the app or the tests will use (a branch created later copies its parent's roles): in the Neon console, or as the owner with `CREATE ROLE fca_app LOGIN PASSWORD '…'` using a generated password that you put only in `.env`. It must not have `BYPASSRLS` or the `neon_superuser` membership (Neon's default owner role has `BYPASSRLS`). Use it in the **pooled** `DATABASE_URL` / `TEST_DATABASE_URL`. Keep the owner role only in `DIRECT_URL` / `TEST_DIRECT_URL`.
2. As the owner, apply [`prisma/sql/runtime-role.sql`](../prisma/sql/runtime-role.sql) to each database: `npm run db:apply-runtime-role` (dev, over `DIRECT_URL`) and `npm run db:apply-runtime-role -- --test` (`TEST_DIRECT_URL`). It is idempotent, so run it **again after every migration that adds tables** (`npm run test:int` does this for the test database on every run). It grants DML, withholds UPDATE/DELETE/TRUNCATE on `audit_events` and `security_events` and hides `_prisma_migrations`.
3. The script also pins `ALTER ROLE fca_app SET timezone = 'UTC'`. Prisma's pg adapter sends timestamps **without an offset**, so a non-UTC session silently shifts every stored time (Neon's default is UTC; role-level settings survive the pooler, a per-session `SET` would not). `test/database/session-timezone.int-spec.ts` checks it.
4. `test/database/runtime-role.int-spec.ts` fails until this is done: that is deliberate (a runtime connection that owns the tables or can update the audit trail is a misconfiguration).

## 5. Things that behave differently on Neon
- **Cold starts**: compute scales to zero. The first query after idle can take seconds. `DATABASE_CONNECT_TIMEOUT_MS` defaults to 10 s; the first manual request after a break may need a retry. A database that is unreachable answers 503 with `Retry-After: 5`, never a 500.
- **Network path (measured, Windows dev machine to `us-east-2`)**: about 300 ms per query round trip and 3 to 5 s to open a new connection. A Neon host resolves to several IPv4 and IPv6 addresses; where some are unreachable Node can stall about 22 s on one before failing (3 of 20 new connections). The API and every script therefore set IPv4-first resolution and a 2 s per-address attempt timeout at start-up (`src/common/http/network.ts`; env `DNS_RESULT_ORDER`, `NET_ATTEMPT_TIMEOUT_MS`): 0 failures in 45 connections, median connect 3.5 s to 2.1 s. The default 250 ms attempt timeout is shorter than one round trip here and makes Node race extra sockets.
- **Prisma interactive transactions** wait only 2 s for a connection by default; on this path that fails with "Unable to start a transaction in the given time". `UnitOfWork` passes `DATABASE_CONNECT_TIMEOUT_MS` as `maxWait` and `DATABASE_TRANSACTION_TIMEOUT_MS` as `timeout`.
- **Latency is a design input**: every extra statement costs about 300 ms from this machine, so keep request transactions short and set-based (the `set_config` for RLS is one extra round trip). **Region** also decides where personal data lives; it is a G0 data-residency decision, see [ADR-0004](adr/0004-tenancy-and-rls.md).
- **Pooler limits**: no session state between statements; use transactions with `set_config(..., true)`, `pg_advisory_xact_lock`, and no `LISTEN/NOTIFY` (see `database-and-tenancy`).
- **Branch resets**: reset `test` from its parent whenever you want a clean slate; data on `test` has no value.
- **Roles**: the runtime connects as the non-owner `fca_app` role without `BYPASSRLS`; migrations run as the owner (see "Runtime role" above).

## 6. Verification on Neon (2026-10-15)
Run against Neon PostgreSQL 18.6, project region `us-east-2`, database `fca_test` on the pooled URL as `fca_app` (migrations as the owner on the direct URL):

| Check | Result |
|---|---|
| `@prisma/adapter-pg` on the pooled URL | works (needs UTC sessions, see above) |
| `migrate deploy` on the direct URL; `migrate dev` shadow database | works; a no-change `migrate dev --create-only` produced an empty migration, i.e. no drift |
| `set_config('app.org_id', …, true)` inside an interactive transaction, through PgBouncer | visible to the next statement in the same transaction, absent afterwards (12 later reads on pooled connections: no leak); 12 concurrent transactions with different tenants each saw only their own value |
| RLS policies (the draft that became migration `row_level_security`) for the non-owner `fca_app` | fails closed with no setting (0 rows), isolates per tenant, rejects a cross-tenant write (`WITH CHECK`); the owner role bypasses it, so migrations, resets and tests keep working; policies were removed again afterwards |
| Overhead of the `set_config` statement | one round trip (about 300 ms from this machine, measured as the median difference between a transaction with and without it) |
| `npm run test:int` | 49 of 49 tests pass |
| Playwright journeys (Edge, real API) | 8 of 8 passed on 2026-10-15, but that run used the DEV database `neondb` as the owner role (the API was started with a `DATABASE_URL` that never took effect, so it read `.env`), not `fca_test` as `fca_app`, and it left 8 `e2e-*@example.test` accounts there. Not repeated on `fca_test` |

The S5 probe is not kept in the repository (it TRUNCATEd and re-created fixtures). RLS was adopted in Phase 2c; `test/database/rls.int-spec.ts` is its permanent check on every `test:int` run.

**Scripts and `DIRECT_URL`.** Prisma CLI commands and `scripts/*.mjs` (`db-apply-sql`, `platform-admin`) need the DIRECT (non-pooled) host of the database. Never point `DIRECT_URL` at the `-pooler` host: Prisma takes a session advisory lock for migrations, and through PgBouncer that lock stays on a pooled server connection that other clients then share, so the next migration times out with "Timed out trying to acquire a postgres advisory lock". Recover by terminating the idle holder (`pg_terminate_backend` on the pid in `pg_locks` for the advisory lock, as the owner).

## 7. A demo company for hand testing (development database only)
`npm run seed:dev` creates, or refreshes, one fictional organisation in the **dev** database so the app can be tried without registering and inviting people by hand. It is idempotent (fixed ids, upserts) and prints the accounts when it finishes.

- **Needs** the DIRECT (non-pooled) `DIRECT_URL` of the dev database in `.env` (the owner role; see the trap in section 6). It refuses `NODE_ENV=production`, a database whose name contains `test` (the integration tests empty those) and a pooled host, and it never prints a connection string.
- **Accounts** (all verified; one shared published password, so never seed a database that real people can reach): `owner@demo.example.test`, `admin@…`, `manager@…`, `courses@…`, `standard@…`, `readonly@…` (one per role), password `demo-company-passphrase-2026`. `former@…` is a deactivated member; `invitee@…` has an open invitation (never emailed).
- **Data**: company settings (with sector, country and DPO contact), six business units (Finance with a head and a child unit Payroll, Human Resources, IT & Security, Operations, and an archived Legacy Unit), one fictional regulator contact, CDPA and GDPR applicable (ISO 27701 declared and removed, to show kept history), the placeholder Professional plan, one audit event.
- **Use your own account as the Owner too**: register and confirm it in the app, then `npm run seed:dev -- --owner you@example.com`.
- **Platform pages** need the platform flag on a real account: `npm run platform-admin -- grant you@example.com`.

## 8. Framework content: verify and load (Phase 4)
Framework requirements (NIST CSF 2.0 and the GDPR so far) are **not** in the database after a migration, and `seed:dev` does not load them. They are loaded by the platform owner, from packs a named person has verified:

```powershell
npm run frameworks:status                                   # what exists, what is verified, what is loaded
npm run frameworks:verify -- nist-csf/2.0 --by "Your Name"  # YOU state you compared the pack with its source
npm run frameworks:verify -- gdpr/2016-679 --by "Your Name"
npm run frameworks:load                                     # needs the DIRECT (non-pooled) DIRECT_URL, owner credentials
```
- **What verifying means.** Open the stored source next to each `pack.json` (`prisma/seed-data/<framework>/<version>/source.*`) and the notes for the verifier in [frameworks/source-registry.md](frameworks/source-registry.md), compare the identifiers and headings, then run `verify`. It writes your name and the time into the pack and binds them to its content hash; editing the pack afterwards makes `load` refuse it. If you are not the right person to verify legal content, do not run it (gate G0: who verifies).
- **Loaded is final.** A loaded version, its requirements and its mapping entries cannot be updated or deleted (database triggers; the app role cannot even write the tables). A correction is a new version with a new label. Removing loaded content by hand needs `ALTER TABLE ... DISABLE TRIGGER` as the table owner and is a deliberate act.
- After loading, the Compliance Mapping page offers the requirements in Add Mapping, and the Framework Reference Guide shows the version, its source and who verified it. Load Default Mappings still answers 422 (no pack ships mapping entries; they need a cited crosswalk or a named legal reviewer).
- Re-fetching a source: `npm run frameworks:extract -- nist --refresh` (or `gdpr`); a verified pack is never overwritten.

## 9. Costs and limits
Free-tier compute hours, storage and branch counts are finite; check the current plan before adding long-running jobs. Frequent job polling keeps compute awake: prefer the external tick endpoint on a schedule (ADR-0006).
