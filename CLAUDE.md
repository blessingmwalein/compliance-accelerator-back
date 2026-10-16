# fca-backend — instructions for Claude Code

Fernando Compliance Accelerator™ (FCA): multi-tenant Governance, Risk & Compliance platform for data-protection programmes (CDPA Zimbabwe, POPIA, GDPR, BDPA Botswana, ISO 27701, NIST CSF). This repository is the **REST API**. The web app is the **separate** repository `fca-frontend` (sibling folder). There is no monorepo: the only link between them is the OpenAPI contract in `contracts/openapi.json`.

The old Base44 front-end copy in `../smaple` is a **business/visual reference only** (incomplete, unverified legal content). What we learned from it is in [docs/reference/legacy-findings.md](docs/reference/legacy-findings.md).

## Stack and pins (verified 2026-10-14; see [ADR-0001](docs/adr/0001-toolchain-pins.md))
Node 24 · **TypeScript 6.0.3 (NOT 7: tooling does not support it yet)** · NestJS 12.1 (ESM) · Prisma **7.10.0** + `@prisma/adapter-pg` (**not** the `prisma@latest` 8.0 release candidate) · PostgreSQL on **Neon** · Vitest 4.1 + supertest · oxlint (type-aware) + Prettier · npm (exact versions, lockfile committed).

## Commands (all run in this folder)
| Command | What it does |
|---|---|
| `npm run start:dev` | API on http://localhost:3001 (docs at `/api/docs`) |
| `npm run verify` | lint + typecheck + unit + e2e + build + openapi:check + check:docs — **run before saying anything is done** |
| `npm test` / `npm run test:e2e` | unit / HTTP tests (no database needed; `npm test` also runs the catalogue and architecture tests in `test/`) |
| `npm run test:int` · `npm run verify:full` | **integration tests on the Neon `test` branch** (destructive; refuse to run unless `TEST_DATABASE_URL`, `TEST_DIRECT_URL`, `ALLOW_DESTRUCTIVE_TESTS=true` name a database containing "test"; they fail, never skip, when unset) · `verify` + `test:int` |
| `npm run lint` / `npm run typecheck` / `npm run format` | static checks / formatting |
| `npm run openapi:export` | rebuild `contracts/openapi.json` (after any controller/DTO change) |
| `npm run db:generate` · `db:migrate:dev` · `db:migrate:deploy` · `db:status` | Prisma (CLI uses `DIRECT_URL`; only `dev` branch for `migrate dev`) |

Windows: use PowerShell or Git Bash; all scripts are Node, none are shell scripts. Use absolute paths in tool calls.

## Non-negotiables
1. **Tenant isolation**: every tenant table has `organisation_id`; every query is scoped by the tenant context; foreign/unknown ids are **404**. No bare-id lookups. → [database-and-tenancy](.claude/skills/database-and-tenancy/SKILL.md)
2. **Deny by default**: every handler declares `@RequirePermission` / `@Public` / `@PlatformOnly`. The frontend is never the only enforcement. → [security-and-rbac](.claude/skills/security-and-rbac/SKILL.md)
3. **Layering**: controller (HTTP) → service (rules, transactions, audit) → repository (the **only** importer of `PrismaService`). `src/domain/` is pure (no Nest/Prisma). → [backend-architecture](.claude/skills/backend-architecture/SKILL.md)
4. **Audit in the same transaction**, fail-closed. Never swallow errors.
5. **No invented legal content.** Framework content needs provenance and a verified status; legal deadlines are data (default "Not configured"). Software does not guarantee compliance. → [compliance-frameworks](.claude/skills/compliance-frameworks/SKILL.md)
6. **Missing data is never a result**: unassessed = `NULL`, no defaults, no "0 %", no "compliant by absence". → [grc-domain](.claude/skills/grc-domain/SKILL.md)
7. **Contract discipline**: change a controller/DTO ⇒ `npm run openapi:export`, bump `CONTRACT_VERSION`, update `contracts/CHANGELOG.md`. Errors are RFC 9457 problem+json with stable `code`s.
8. **Secrets**: only from env, never committed or logged; never paste connection strings into chat. `.env` is git-ignored.
9. **Personal data minimisation**: no DSAR/breach details in logs, emails, job payloads or AI prompts.

## Skills — load before working in the area
| Skill | Load when… |
|---|---|
| [backend-architecture](.claude/skills/backend-architecture/SKILL.md) | adding/changing modules, controllers, services, DTOs, transactions, errors, pagination |
| [database-and-tenancy](.claude/skills/database-and-tenancy/SKILL.md) | schema, migrations, repositories, queries, Neon, RLS, seeds |
| [security-and-rbac](.claude/skills/security-and-rbac/SKILL.md) | auth, sessions, roles/permissions, guards, uploads, secrets |
| [forms-and-validation](.claude/skills/forms-and-validation/SKILL.md) | request DTOs, validation, dates/timezones, pagination params, error shape |
| [grc-domain](.claude/skills/grc-domain/SKILL.md) | scoring, bands, maturity, lifecycles, metrics, Eisenhower rule, deadlines |
| [testing-and-quality](.claude/skills/testing-and-quality/SKILL.md) | writing/running tests, tenancy + RBAC matrices, Neon test branch, DoD |
| [reports-and-documents](.claude/skills/reports-and-documents/SKILL.md) | PDFs, report records, certificates |
| [notifications-and-jobs](.claude/skills/notifications-and-jobs/SKILL.md) | email, reminders, outbox/jobs, scheduling |
| [compliance-frameworks](.claude/skills/compliance-frameworks/SKILL.md) | framework content, seeds, mappings, deadline policies, legal wording |

## Layer and import cheat-sheet
```
controller ──► service ──► repository ──► PrismaService (only here)
     │            └──────► domain/*  (pure)        └──► Postgres (Neon)
     └─ DTOs (*.dto.ts) · decorators: @RequirePermission / @Public / @ApiProblemResponse
```
Cross-module calls go service → service. A module never imports another module's repository.

## Repository map
`src/common` (filters, pipes, request id, OpenAPI helpers) · `src/config` (validated env) · `src/prisma` (`PrismaService`: `db` is the tenant-checked client) · `src/tenancy` (`RequestContext`: request id, actor, tenant in AsyncLocalStorage) · `src/database` (tenancy catalogue, tenant guard, `UnitOfWork`, `TenantRepository`) · `src/audit` (append-only audit writer) · `src/auth` (authentication: service, controllers, `AuthGuard`, password/token/lockout rules) · `src/security-events` (events with no organisation) · `src/jobs` (outbox, runner, tick endpoint, poller) · `src/mail` (provider, file transport, templates) · `src/health` · `src/meta` · `src/domain` (pure logic) · `src/cli` (OpenAPI export) · `prisma/` (schema, migrations, `sql/` draft role + RLS scripts) · `contracts/` · `docs/` · `.claude/skills/` · `test/` (catalogue + architecture tests, `support/`, `*.int-spec.ts`).

## Definition of done (every feature)
Frontend functional · backend endpoint works · persisted in PostgreSQL · validation on both sides · permissions enforced server-side · tenant isolation tested · loading/empty/success/failure states handled · relevant actions audited · tests pass · build passes · docs updated. Details and per-module criteria: [docs/acceptance-criteria.md](docs/acceptance-criteria.md).

## Working in phases
Work in controlled phases ([docs/implementation-plan.md](docs/implementation-plan.md)); never generate the whole app in one pass. **Stop at the end of each phase and report**:
1. Implemented functionality · 2. Changed files · 3. API endpoints (+ contract version) · 4. Migrations · 5. Tests executed · 6. Test results (paste real output; say plainly what failed or was skipped) · 7. Known limitations · 8. Next recommended task.
Do not commit or push unless the user asks. A route not yet implemented must be marked **pending**, never presented as done.

## Pins and traps
- `typescript` must stay 6.0.x: `nest new`/Vite templates may pull 7.x; typescript-eslint, ts-jest-style tools and `@nestjs/swagger` do not support it yet.
- `prisma generate` must work **without any env** (`prisma.config.ts` sets `datasource.url` only when `DIRECT_URL` exists). Migrations use `DIRECT_URL`; the app uses the pooled `DATABASE_URL`.
- `ConfigService.get` falls back to raw `process.env`, where an empty string counts as set: normalise (`|| undefined`).
- `class-transformer` implicit conversion turns `"false"` into `true`: read the raw value in `@Transform`.
- Install scripts are decided explicitly in `package.json` `allowScripts` (npm 11): `prisma` and `@prisma/engines` allowed (engine download), `@scarf/scarf` (telemetry) **denied**. A new dependency with an install script needs a deliberate `npm approve-scripts` / `npm deny-scripts` decision (argon2 will in Phase 2b).
- `postinstall` runs `prisma generate`, which needs the `prisma` devDependency. Build in a stage with dev dependencies; a production image that installs with `--omit=dev` must use `--ignore-scripts` and copy the already-built `dist/` (the generated client is compiled into `dist/generated`).
- The Neon pooler is PgBouncer in transaction mode: no session state, no session advisory locks, no `LISTEN/NOTIFY`.
- Vitest 4 reads `test.env` from `vitest.config*.ts` (`DATABASE_URL=''`): unit and e2e tests never touch a real database.
- `prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script` prints **nothing** unless `DIRECT_URL` is set to any syntactically valid URL (it only needs the provider). Prefer `prisma migrate dev --create-only` on the `dev` branch; hand-written SQL (checks, triggers) is appended to the generated migration **before** it is first applied, never after.
- Prisma queries are **lazy thenables**: the tenant safety net runs when the query is first awaited. `RequestContext.run` starts any returned thenable inside the scope, but always `await` queries inside services; never hand an un-awaited Prisma promise to code running outside the request scope.
- Prisma hides the SQLSTATE class 23 message of a trigger (it reports "Foreign key constraint violated"): raise with the default `raise_exception` (no custom `ERRCODE` in the 23xxx class) so the text reaches the caller (the audit trigger does).
- Neon's default database is `neondb` on **every** branch, so the destructive-test guard (database name must contain `test`) requires you to create a separate database (for example `fca_test`) on the `test` branch.
- **Neon network traps (measured):** a Neon host resolves to IPv4 and IPv6 addresses and Node can stall about 22 s on an unreachable one (`ETIMEDOUT`): the app and scripts call `configureNetwork` (`src/common/http/network.ts`: IPv4 first, 2 s per-address timeout), so any new script or test process that opens a database connection must do the same. Prisma interactive transactions wait only **2 s** for a connection unless `maxWait` is set (`UnitOfWork` sets it from env). From a distant region every statement costs a round trip (about 300 ms measured to `us-east-2`) and a new connection 2 to 5 s: keep transactions short, never add statements to hot paths casually, and expect `test:int` to take minutes (timeouts are generous on purpose).
- The runtime role `fca_app` is created once per branch with plain SQL (no `BYPASSRLS`); `npm run db:apply-runtime-role` re-applies its grants as the owner (`-- --test` for `fca_test`) after every migration that adds tables; `test:int` does it for the test database itself.
- **`JWT_ACCESS_SECRET` has no default** (the app refuses to start without 32+ characters). `.env` is git-ignored; copy `.env.example` and generate one: `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`. Never paste it anywhere.
- `ConfigModule.forRoot` validates the environment at **import time** of `AppModule`: tests that need another environment set `process.env` first and `await import()` the module (see `test/throttle.e2e-spec.ts`).
- The database session must run in **UTC** (Prisma's pg adapter sends offset-less timestamps). Neon defaults to UTC; `prisma/sql/runtime-role.sql` pins it; `test/database/session-timezone.int-spec.ts` checks it.
- `@node-rs/argon2` is used instead of `argon2` (no install script); its `Algorithm` is a const enum, so do not import it (isolatedModules); the spec asserts the `$argon2id$` prefix.
- One-time email tokens are created by the **job** at send time and travel in the URL **fragment**; never put a raw token in a job payload, a log line or a database column (only its SHA-256).
- A database that is down answers `503 DATABASE_UNAVAILABLE` + `Retry-After` (the problem filter recognises Prisma connectivity errors), never a generic 500.
- Never write regex-replace scripts whose replacement text contains `$` (JavaScript expands `$'` and `` $` ``) or long shell heredocs with quotes; use the editor tools.
- **Row-level security is ON (2c).** Tenant data is read and written only inside `uow.run` (a bare tenant query returns NOTHING, silently); tenant repository methods take `tx`; a migration adding a tenant table ends with `SELECT fca_enable_tenant_rls('<table>')`; pre-tenant reads use the SECURITY DEFINER functions (`fca_membership_of`, …). Integration tests read tenant rows inside `ctx.uow.run` and seed with the owner-role `ctx.admin`.
- **One `AccessGuard`, one declaration per handler** (`@Public`, `@Authenticated`, `@RequirePermission`, `@OrganisationMember`, `@PlatformOnly`); permission keys are the typed catalogue in `src/permissions/catalogue.ts` and docs/rbac-matrix.md must equal it (a test parses the tables). Platform admins are made with `npm run platform-admin -- grant <email>` only.
- **Never run Prisma CLI commands through a pooled `DIRECT_URL`** (the `-pooler` host): the migration advisory lock stays on a shared pooled connection and the next migration times out. Use the direct host; recover with `pg_terminate_backend` on the idle holder (docs/neon-setup.md).
- The Swagger plugin documents only files named `*.dto.ts`: a query DTO elsewhere (`PageQueryDto`) needs explicit `@ApiPropertyOptional`, or the parameters vanish from the contract.
- `UnitOfWork` always sets `app.org_id` (the `DATABASE_RLS_ENABLED` switch is gone). New-organisation flows generate the id up front (`uuidv7()`) and run in `requestContext.runInOrganisation(id, …)`.
- **An unquoted URL in a sourced env file loses everything after the first `&`** (the shell backgrounds the command), so the variable is silently NOT set and the app falls back to `.env` (the dev database). Quote every URL (`NAME="postgres://…"`) and, before a destructive or write-heavy run, check which database the process really uses (`SELECT current_database()`). This is how an early Playwright run ended up on the dev database.
- Raw SQL (`$queryRaw`, `$executeRaw`) is allowed only in `*.repository.ts`, `src/prisma` and `src/database` (enforced by `test/architecture.spec.ts`); the `*Unsafe` variants are banned.

- **Reference tables are never emptied.** `frameworks` and `plans` are seeded by a migration and are global (no `organisation_id`); the integration global setup skips truncating them. A new global reference table needs the same exclusion (`test/support/int-global-setup.ts`).
- **Migration order is by folder name.** `prisma migrate dev --create-only` stamps the UTC clock, which can sort BEFORE hand-named migrations whose helper functions it needs: rename the folder (the `…140000_setup_modules` and `…160000_company_sector_and_unit_fields` migrations were renamed for this). Never rename a migration that has been applied; `prisma format` also realigns `schema.prisma`, so scripted exact-string edits of it fail.
- **Entitlements are snapshots, no plan means no limits.** Read limits from `organisation_entitlements`, never from the plan; never treat a missing entitlement as zero. Enforce inside the service transaction.
- **Settings and business units.** Required settings (`name`, `timezone`, `country`, `dpoEmail`) cannot be cleared: null or blank means "unchanged"; optional ones clear with null or blank. Business-unit codes are unique per organisation including archived units; a unit is archived, never deleted; the head must be an ACTIVE member. A logo change must not touch the organisation `version`.
- **A test company for hand testing** lives in the dev database: `npm run seed:dev` (docs/neon-setup.md section 7). Do not start or stop the owner's dev servers; they run `npm run start:dev` and `npm run dev` themselves.
- **JavaScript `String.replace` with a replacement string treats `$1`, `$&` as patterns**: in edit scripts use a function replacement (`text.replace(from, () => to)`).
- **Phase 3 has no new automated tests** (owner decision). Do not read the absence of a test as the absence of a rule: the rules are in docs/acceptance-criteria.md with their status.

- **Framework content is data with provenance, never typed from memory.** Requirements, versions and mapping entries are GLOBAL tables written only by `npm run frameworks:load` (owner credentials) from `prisma/seed-data/<framework>/<version>/pack.json`; the loader accepts only a pack a named person verified (`frameworks:verify -- <pack> --by "Name"`) whose content hash and stored source file still match. Never mark a pack verified yourself, never load a draft, never add mapping entries without a cited crosswalk or a named legal reviewer. The app role cannot write these tables and database triggers freeze a loaded version (to correct one, make a NEW version; removing one needs `ALTER TABLE ... DISABLE TRIGGER` as owner). A new global reference table needs the same `REVOKE` in `prisma/sql/runtime-role.sql` and an exclusion in `test/support/int-global-setup.ts`.
- **Fetching sources:** EUR-Lex answers scripts with a 202 challenge page; the EU Publications Office returns the same Official Journal text at `publications.europa.eu/resource/celex/<celex>` with `Accept: application/xhtml+xml`. The NIST "json" download URL actually returns an .xlsx (a Reference Tool export that also lists withdrawn CSF 1.1 items). Never overwrite a downloaded source with a probe: save to a named file first.
- **Mapping rules to keep:** a mapping links DIFFERENT frameworks; a pack entry is copied into an organisation once, in any state (unique on `source_entry_id`), so Load Default Mappings neither duplicates nor resurrects; a seeded mapping only changes its area and review status; an archived area with live mappings stays visible in the matrix.
- **Do not hand-write backslash regexes through shell heredocs into script files:** the backslashes get lost (this broke two edit scripts); use the Edit tool for any line containing `\`.

## Open decisions (gate G0; see implementation plan)
Hosting + same-site domains (refresh cookie), email provider, object storage, who verifies legal content, Neon region vs data residency, AI provider, organisation provisioning model, platform-admin flag (assumed, confirm).
