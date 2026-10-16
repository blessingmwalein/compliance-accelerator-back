---
name: testing-and-quality
description: Use when writing or running tests, adding endpoints that need tenancy/RBAC matrix coverage, working with the Neon test branch, metric golden tests, contract drift checks, lint/typecheck, or deciding whether a backend change is done.
---

# Testing and quality (backend)

## When to use
Every change. A feature is done only when the Definition of Done in `docs/acceptance-criteria.md` is met, including tests. Run `npm run verify` before reporting anything as complete.

## Rules

### Commands
| Command | Purpose | Needs |
|---|---|---|
| `npm run lint` | oxlint with **type-aware** rules (`no-floating-promises`, `no-misused-promises` are errors) | nothing |
| `npm run typecheck` | `tsc --noEmit` (TypeScript 6.0.x) | nothing |
| `npm test` | unit tests (`src/**/*.spec.ts` and `test/**/*.spec.ts`): pure logic, filters, pipes, config, plus the catalogue test (`test/database/catalogue.spec.ts`), the architecture test (`test/architecture.spec.ts`) and the destructive-test guard (`test/support/test-database.spec.ts`) | nothing |
| `npm run test:e2e` | HTTP surface with supertest, no database (`test/**/*.e2e-spec.ts`) | nothing |
| `npm run test:int` | **integration on the Neon `test` branch** (`test/**/*.int-spec.ts`, `vitest.config.int.ts`); the global setup runs the destructive-test guard, `prisma migrate deploy` (direct URL, retried for cold starts) and empties every table | `TEST_DATABASE_URL`, `TEST_DIRECT_URL`, `ALLOW_DESTRUCTIVE_TESTS=true` |
| `npm run build && npm run openapi:check` | compile and verify the contract file is current | nothing |
| `npm run check:docs` | skills/CLAUDE.md/`.env.example` consistency | nothing |
| `npm run verify` | lint + typecheck + unit + e2e + build + openapi:check + check:docs (the CI equivalent) | nothing |
| `npm run verify:full` | `verify` + `test:int` | Neon test branch |

### Test helpers added in Phase 2b
- `test/support/auth-world.ts` (`createAuthWorld`): an in-memory stand-in for the auth repositories, jobs and security events, with a hand-moved `TestClock`, so `AuthService` rules (lockout, rotation, reuse, single-use tokens, uniform responses) are tested for real without a database. Mutation-check security-critical lines when you change them: remove the line, the spec must fail.
- `test/support/mail.ts` reads the `.eml` files the file transport wrote (token included); `test/support/int-context.ts` boots the real app with `configureApp` and exposes `http()` (supertest) and `runner` (call `runner.runBatch()` instead of waiting for the poller).
- **`ConfigModule.forRoot` validates the environment when `AppModule` is first imported**, so an e2e test that needs a different environment must set `process.env` and then `await import('../src/app.module.js')` inside `beforeAll` (see `test/throttle.e2e-spec.ts`).
- `vitest.shared.ts` holds the hermetic test environment (public test secrets, cheap argon2, a temp mail directory, no poller, no throttling).

### What to test where
1. **Domain (`src/domain`)**: table-driven tests including every band boundary, empty/partial inputs, and (where useful) property-style invariants. No mocks needed because the code is pure.
2. **Services**: unit tests with fake repositories for rules and error codes; transactions and constraints are proven in integration tests, not mocked.
3. **HTTP**: e2e tests for status codes, problem+json shapes, headers, validation, CORS (`test/app.e2e-spec.ts` is the template).
4. **Integration (real PostgreSQL only)**: repositories, constraints, composite FKs, RLS, migrations, audit immutability, job leasing. **Never mock Prisma for tenancy or constraint behaviour**; PGlite/SQLite cannot reproduce RLS or Neon behaviour.
5. **Contract**: `contracts/openapi.json` must equal the generated document (`openapi:check`) and carry `CONTRACT_VERSION` (`src/meta/contract.spec.ts`).

### The two generated matrices (**built in Phase 2c**: `test/organisations/access-matrix.int-spec.ts`) — every organisation endpoint is covered automatically
- **Tenancy matrix**: the suite walks the route table (`discoverRoutes()` in `test/support/routes.ts` reads the controllers' metadata, so a new endpoint is covered the moment it exists) and probes each tenant route (empty body and an id that exists nowhere, so allowed callers stop at validation or "not found" and nothing changes): anonymous ⇒ 401; authenticated non-member ⇒ 404; org-B member calling an org-A path ⇒ 404; org-A path with an org-B record id ⇒ 404; member without the permission ⇒ 403; list endpoints return only the caller organisation's rows. Fixtures: `createOrganisationWithAllRoles` (one active member per role) and `createPerson` (a user with a live session and a signed token, a few queries instead of register/confirm/sign-in). Record-id isolation (a foreign member or invitation id is a 404 and the foreign row is untouched) is asserted per resource in `organisations-flow.int-spec.ts`; adding a resource means adding its case there. `test/rbac-matrix-doc.spec.ts` fails when docs/rbac-matrix.md differs from the catalogue.
- **RBAC matrix**: generated from the permission catalogue × the six roles; asserts each role gets exactly the documented allow/deny for every `@RequirePermission` endpoint.
- A third check fails the build for any handler without exactly one access declaration (`access-declaration.e2e-spec.ts`), and checks that the contract states it (`x-access`, `x-permission`).
- **Row-level security** is checked as the runtime role with raw SQL that bypasses the repositories (`test/database/rls.int-spec.ts`); tenant reads in an integration test run inside `ctx.uow.run` (a bare query sees nothing).

### Metric golden tests
Each dashboard metric has fixtures for: no data, partial coverage, full data, and edge cases (all overdue, nothing due yet). The expected `availability/status/value/coverage` are asserted against the definition sheet in `docs/metrics/`.

### Neon test branch hygiene (MUST)
- `TEST_DATABASE_URL`/`TEST_DIRECT_URL` point at the **`test`** branch. The test bootstrap **aborts** unless the database name contains `test` and `ALLOW_DESTRUCTIVE_TESTS=true`. Never point them at `dev` or `main`.
- Integration tests run **serially** (`fileParallelism: false`), truncate tenant tables at suite start, and create their own organisations per test (unique ids), so no global clean-up is needed between tests. Tolerate Neon cold starts: retry the first connection with a generous timeout in global setup.
- A missing `TEST_DATABASE_URL` makes `test:int` **fail with a clear message** (it never silently skips). The guard (`assertSafeTestDatabase`) also refuses a database not named like a test database, mismatched pooled/direct strings, and a test database equal to the dev one; its messages never contain credentials or hosts.
- Helpers in `test/support`: `createIntContext()` boots the real `AppModule` (runtime connection: pooled URL, tenant safety net) and an **owner-role `admin` client** that bypasses the safety net on purpose, for seeding and checking only; `seedTwoOrganisations(admin)` makes two organisations with one owner each. In a test, wrap tenant work in `requestContext.run({ organisationId, actorUserId }, …)`.
- `runtime-role.int-spec.ts` fails until the non-owner `fca_app` role and `prisma/sql/runtime-role.sql` are in place on the test branch (deliberate; see `docs/neon-setup.md`).
- A plumbing check on an embedded PostgreSQL (PGlite plus `@electric-sql/pglite-socket`, installed with `npm install --no-save`, never committed) was used once in Phase 2a to debug the integration specs and the SQL. It **cannot** reproduce Neon, the pooler, roles per connection or the privilege spec, so it never replaces `test:int` on Neon (which passes 49 of 49 as of 2026-10-15; each run takes minutes because every statement is a round trip to the Neon region, hence the large `testTimeout`/`hookTimeout` in `vitest.config.int.ts`, and the admin client retries transient connection errors).

### Quality gates
- Lint, typecheck, tests, build all clean; no `any` introduced casually (`typescript/no-explicit-any` is off only because DTO/validation plumbing sometimes needs it: justify in review); no `console.log` in `src/` (use the pino logger; `main.ts` and `cli/` may write to stderr/stdout).
- Coverage gates apply to `src/domain` and policies (aim ≥ 90 % lines there); do not chase coverage elsewhere.
- Tests are deterministic: inject clocks, no real network, no sleeping; random data uses seeded generators.

## Example

```ts
// src/domain/scoring/exposure.spec.ts
describe('bandFor (exposure_v1 defaults)', () => {
  it.each([
    [25, 'Low'], [26, 'Medium'], [60, 'Medium'], [61, 'High'], [90, 'High'], [91, 'Critical'],
  ])('score %i is %s', (score, band) => {
    expect(bandFor(score, DEFAULT_EXPOSURE_BANDS).name).toBe(band);
  });
  it('returns not_assessed instead of a number when any input is missing', () => {
    expect(exposure({ sensitivity: 3, severity: null, likelihood: 2 })).toEqual({
      state: 'not_assessed', missing: ['severity'],
    });
  });
});
```

```ts
// test/tenancy/org-isolation.int-spec.ts (shape)
it.each(tenantRoutes)('%s hides foreign records', async (route) => {
  const { orgA, orgB, tokenB } = await fixtures.twoOrganisations();
  const recordA = await fixtures.createFor(route.resource, orgA);
  await api.as(tokenB).get(route.path(orgA.id, recordA.id)).expect(404);      // not 403
});
```

## Anti-patterns
- Mocking the database for tenancy tests; sharing one database between parallel test workers; running destructive tests on `dev`.
- Tests that pass only because defaults hide missing data; asserting the legacy behaviour (e.g. "unassessed ⇒ 0 %").
- Snapshotting whole OpenAPI/PDF output instead of asserting the specific contract/fields.
- Skipping a failing test or loosening a matrix to get green; reporting "done" without running `verify`.
- Time-dependent tests using the real clock.

## Checklist
- [ ] `npm run verify` passes (and `verify:full` from Phase 2a)
- [ ] New domain logic has boundary-value tests and empty/partial-data tests
- [ ] New endpoint appears in the tenancy + RBAC matrices and has a fixture
- [ ] Metrics have a definition sheet entry and golden tests
- [ ] Contract regenerated, `CONTRACT_VERSION` bumped when the contract changed
- [ ] No test depends on the dev/main Neon branches, the real clock or the network

## References
`vitest.config.ts`, `vitest.config.e2e.ts`, `test/app.e2e-spec.ts`, `docs/acceptance-criteria.md`, `docs/metrics/README.md`, `database-and-tenancy`, `security-and-rbac`.
