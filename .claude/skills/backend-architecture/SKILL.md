---
name: backend-architecture
description: Use when adding or changing a NestJS module, controller, service, repository, DTO, guard, interceptor, transaction, pagination or error handling in fca-backend. Defines layering, the request pipeline, transactions + audit, and API conventions.
---

# Backend architecture

## When to use
Any change under `src/` that adds an endpoint, a module, a repository, a DTO, a background handler or changes how requests flow. Load `database-and-tenancy` too whenever the change touches persistence, and `security-and-rbac` whenever it adds an endpoint.

## Rules

### Layering (MUST)
1. **Controller** = HTTP only: route, DTO binding, permission decorator, call one service method, map to a response DTO. No business rules, no Prisma, no `Request` objects passed down.
2. **Service** = business rules, orchestration, transactions, audit events, calls to `domain/` functions. No `express`/HTTP types. Throws `AppException` with a stable `code`.
3. **Repository** (`*.repository.ts`) = persistence only. It is the **only** layer allowed to import `PrismaService` (health probes are the single documented exception). Repositories extend the tenant-scoped base (see `database-and-tenancy`) and never expose Prisma entity types outside the module; they return plain domain/read models.
4. **`src/domain/`** = pure functions (scoring, roll-ups, state machines, metric states). **No Nest, no Prisma, no I/O.** Table-tested.
5. Modules own their DTOs. Cross-module calls go through the other module's **service** (exported), never its repository.
6. Enforce #3 and #4 mechanically: `test/architecture.spec.ts` (runs in `npm test`, rules in `test/support/architecture-rules.ts`) fails the build when Prisma, the generated client or `PrismaService` is imported outside `*.repository.ts`, `src/prisma/`, `src/database/`, `src/health/`; when `src/domain` imports anything outside `src/domain`; when a controller imports a repository; when raw SQL (`$queryRaw`, `$executeRaw`) appears outside repositories and those infrastructure folders (the `*Unsafe` variants nowhere); or on `console.log` in `src` (except `main.ts`, `cli/`). Each rule is proven to fail on a planted violation.

### Request pipeline (order is part of the contract)
`request-id (pino-http)` → `helmet` → `CORS` → `RequestContextMiddleware` (opens the request scope; built in Phase 2a) → `throttler` (Phase 2b) → body parsing → `AuthGuard` (Phase 2b, **deny by default**) → `AccessGuard` (Phase 2c: platform flag, or ACTIVE membership + permission; an undeclared handler is denied; entitlements arrive in Phase 3) → `ValidationPipe` → handler → response interceptors (serialisation) → `ProblemDetailsFilter` for every error.

### DTOs and the contract (MUST)
- Separate **Create/Update/Response** DTO classes per resource, in `*.dto.ts` (the Swagger CLI plugin infers `@ApiProperty` from these files; add JSDoc comments, they become API descriptions).
- Never return Prisma models or accept them. Never accept `organisationId`, `createdBy`, `status` transitions or audit fields from the body: they come from the request context or a dedicated action endpoint.
- Every endpoint has an explicit `operationId` (`@ApiOperation({ operationId })`), a response `type`, and `@ApiProblemResponse(status, description)` for each error status it can produce. `operationId`s become frontend hook names: keep them stable and verb-first (`getMeta`, `listBusinessUnits`).
- Any change to `openapi.json` ⇒ bump `CONTRACT_VERSION`, update `contracts/CHANGELOG.md`, run `npm run openapi:export`. `openapi:check` and `src/meta/contract.spec.ts` fail on drift.

### Errors (MUST)
- Throw `AppException(code, status, detail?, errors?)` from services. Add new codes to `ErrorCode` and the changelog; never invent strings inline.
- Errors are RFC 9457 `application/problem+json` rendered only by `ProblemDetailsFilter`. Never catch-and-swallow; never return `200` with an error body.
- 404 for records the caller cannot see (including other tenants'), 403 for a member lacking permission, 409 for state/uniqueness conflicts, 422 for domain-rule violations that are well-formed requests (e.g. `SEED_DATA_UNAVAILABLE`).

### Transactions, audit, idempotency (MUST)
- **Tenant data is read and written only inside `uow.run`** (row-level security sees no rows outside it); tenant repository methods take `tx` as their first parameter. Lists use cursor pagination (`PageQueryDto`, `toPage`, `limit + 1` rows) and carry `@ApiPropertyOptional` on the query DTO (the Swagger plugin only auto-documents files named `*.dto.ts`).
- An operation that changes more than one row, or a row plus an audit event, runs in **one transaction**: `UnitOfWork.run(async (tx) => …)` (`src/database`, short transactions: 10 s default limits). Audit events are written **inside** that transaction with `AuditService.record(tx, { action, entityType, … })` (action from the typed `AUDIT_ACTIONS` catalogue; actor, request id and organisation come from `RequestContext`, never from the caller) and a failed audit insert fails the operation (fail-closed, no try/catch): the legacy app swallowed audit errors. `changes` carries field-level before/after values only (secrets are redacted, personal free text must not be passed).
- Request-scoped state (request id, actor, tenant) lives in `RequestContext` (`src/tenancy`), opened by `RequestContextMiddleware` for every request. Guards enrich it with `update`; services and repositories only read it.
- `POST` that creates must accept an optional `Idempotency-Key` header (stored per organisation + endpoint) so retries do not duplicate (the `idempotency_keys` table exists since Phase 2a; the service and interceptor land with the first create endpoint, so write them then, with the contract bump).
- Updates use optimistic concurrency: resources carry an integer `version`; `PATCH/PUT` requires the current `version`, mismatch ⇒ `409 CONFLICT`.
- Lists use **cursor pagination** with `limit` (default 25, max 100) and a stable sort; never unbounded `findMany`.

### Configuration and logging
- Read configuration only through `ConfigService<EnvironmentVariables, true>`; add every new key to `env.schema.ts` **and** `.env.example` (`npm run check:docs` enforces it).
- Gotcha: `ConfigService.get` falls back to raw `process.env`, where an empty string counts as set. Normalise (`|| undefined`) when "empty" means "not configured".
- Logs are structured (pino). Never log request bodies, tokens, cookies, connection strings or personal data from DSAR/breach records. `authorization`, `cookie` and `set-cookie` are redacted centrally.

## Example

A minimal module (controller, service in one transaction with audit):

```ts
// business-units/business-units.controller.ts
@ApiTags('business-units')
@Controller('organisations/:organisationId/business-units')
export class BusinessUnitsController {
  constructor(private readonly service: BusinessUnitsService) {}

  @Get()
  @RequirePermission('businessUnits.view')
  @ApiOperation({ operationId: 'listBusinessUnits', summary: 'List business units' })
  @ApiOkResponse({ type: BusinessUnitPageDto })
  list(@Query() query: ListBusinessUnitsQueryDto): Promise<BusinessUnitPageDto> {
    return this.service.list(query);          // organisation comes from TenantContext, not the URL param
  }

  @Post()
  @RequirePermission('businessUnits.create')
  @ApiProblemResponse(HttpStatus.CONFLICT, 'Code already used in this organisation.')
  create(@Body() dto: CreateBusinessUnitDto): Promise<BusinessUnitDto> {
    return this.service.create(dto);
  }
}

// business-units/business-units.service.ts
async create(dto: CreateBusinessUnitDto): Promise<BusinessUnitDto> {
  return this.uow.run(async (tx) => {                   // one transaction
    if (await this.repo.codeExists(tx, dto.code)) {
      throw new AppException('BUSINESS_UNIT_CODE_TAKEN', HttpStatus.CONFLICT, 'Code already used.');
    }
    const created = await this.repo.create(tx, dto);
    await this.audit.record(tx, 'business_unit.created', { entityId: created.id });   // same tx, fail-closed
    return toDto(created);
  });
}
```

## Anti-patterns
- Business rules in controllers or React components; derived values (exposure, level, gap) **persisted** and going stale: compute with `domain/` functions and store only raw inputs plus the methodology version.
- Sequential `await`-in-a-loop bulk creates with no transaction and client-side de-duplication: use one transaction and unique constraints.
- `findUnique({ where: { id } })` without the organisation; trusting an id from the URL or body.
- Swallowed errors, `console.error`, `alert()`-style failure handling; returning `200` for failures.
- Free-text owners and "magic strings" (`"Unassigned"`, `"company-wide"`) in id columns: use nullable foreign keys.
- Unbounded list endpoints and per-widget "fetch everything then aggregate in the browser".

## Checklist
- [ ] Controller thin, service owns rules, repository is the only Prisma importer
- [ ] DTOs separate for create/update/response; no tenant/audit fields accepted from the client
- [ ] `operationId`, response types and `@ApiProblemResponse` on every endpoint; contract version bumped + changelog + `openapi:export` run
- [ ] Multi-row/audited changes run in one transaction; audit written in it; errors are `AppException` with a stable `code`
- [ ] Lists paginated (cursor, capped); updates use `version`; creates accept `Idempotency-Key`
- [ ] New env keys in `env.schema.ts` and `.env.example`
- [ ] Unit tests for services/domain, e2e for the HTTP surface, tenancy + RBAC matrix entries (see `testing-and-quality`)

## References
`src/common/*` (filter, pipe, request id), `src/config/env.schema.ts`, `docs/architecture.md`, ADR-0002 (contract), `database-and-tenancy`, `security-and-rbac`, `forms-and-validation`.
