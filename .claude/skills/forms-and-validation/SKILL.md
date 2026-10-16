---
name: forms-and-validation
description: Use when writing or changing request DTOs, validation rules, query/pagination parameters, date/time handling, enum exposure or the error shape returned for invalid input in fca-backend (the server side of every form).
---

# Forms and validation (backend)

## When to use
Whenever an endpoint accepts input. The frontend validates with Yup for UX; **the server is the authority** and its rules must be at least as strict. Load `backend-architecture` for the module structure.

## Rules

### DTOs
1. One class per use: `CreateXDto`, `UpdateXDto` (all optional + required `version`), `ListXQueryDto`, `XDto` (response). Files end `.dto.ts`.
2. Validate with **class-validator** decorators (the repository standard; Nest 12 also supports Standard Schema validators but we do not mix). Every string has `@MaxLength`, every array `@ArrayMaxSize`, every number `@Min/@Max`. Trim strings with `@Transform` where meaningful. Enums use `@IsEnum`.
3. The global pipe (`createValidationPipe`) uses `whitelist: true`, `forbidNonWhitelisted: true`, `transform: true`, **no implicit conversion**. Unknown properties are rejected (this is the mass-assignment defence). Query/path numbers use explicit `@Type(() => Number)` / `ParseUUIDPipe` / `ParseIntPipe`.
4. **Never** accept: `organisationId`, `userId`, `createdBy/At`, `version` on create, computed fields (`risk_exposure`, `gap`, `risk_level`), status transitions that have a dedicated action endpoint (e.g. `POST …/approve`).
5. Cross-field and domain rules (target ≥ current maturity, due date after received date, residual ≤ inherent) are enforced in the **service/domain layer** and reported as typed errors, not silently clamped.

### Error shape (the contract the frontend maps onto forms)
`400` with `application/problem+json`: `code: "VALIDATION_FAILED"`, `errors: [{ path, code, message }]`.
- `path` is dot notation (`contacts.0.email`); `code` is the class-validator constraint name (`isEmail`, `maxLength`, `whitelistValidation`…) or a domain code (`TARGET_BELOW_CURRENT`); `message` is human-readable but **not stable**.
- Domain-rule violations on well-formed input use **422** with their own `code`; uniqueness/state conflicts use **409**.
- The frontend maps `errors[].path` to React Hook Form fields via `setError`. Keep paths aligned with the DTO property names.

### Dates and time (MUST)
- Instants are ISO 8601 UTC strings (`2026-10-14T09:30:00.000Z`) stored as `timestamptz`.
- Date-only business values (`dueOn`, `receivedOn`, `reviewOn`) are `YYYY-MM-DD` strings stored as `date`; validate with `@IsDateString({ strict: true })`-style rules plus a custom check that rejects impossible dates.
- Deadlines and "overdue/due soon" are computed in the **organisation's IANA timezone** (`organisations.timezone`), comparing **calendar days**, never `diff(…, 'days')` truncation (the legacy app told people a task due tomorrow was "due today").
- Never use `Date.now()` directly in domain logic: pass a clock (`now: Date`) so tests are deterministic.

### Pagination, filtering, sorting
- `?limit=` (default 25, max 100) and `?cursor=`; responses `{ items, nextCursor }`. Sort keys are an allow-list per endpoint; filters are explicit query DTO fields (validated), never raw `where` objects.

### Enums and the contract
- Enums exposed in DTOs become OpenAPI enums and frontend union types. Adding a value is a **minor** contract bump; removing or renaming is **major**. Status lifecycles (RoPA, risk, task, DSAR, breach) are documented in `grc-domain`.

## Example

```ts
export class CreateRiskDto {
  /** Short title shown in the register. */
  @IsString() @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @MinLength(3) @MaxLength(200)
  name!: string;

  /** 1 (rare) to 5 (almost certain). */
  @IsInt() @Min(1) @Max(5)
  likelihood!: number;

  /** 1 (negligible) to 5 (catastrophic). */
  @IsInt() @Min(1) @Max(5)
  severity!: number;

  @IsOptional() @IsUUID()
  ownerUserId?: string;          // an id, not free text; the service verifies membership in the organisation

  @IsOptional() @IsDateString({ strict: true })
  reviewOn?: string;             // YYYY-MM-DD
}
```

```jsonc
// 400 application/problem+json
{
  "type": "urn:fca:problem:validation-failed", "title": "Bad Request", "status": 400,
  "code": "VALIDATION_FAILED", "detail": "Request validation failed.",
  "errors": [{ "path": "likelihood", "code": "max", "message": "likelihood must not be greater than 5" }],
  "requestId": "6d0f…"
}
```

## Anti-patterns
- Trusting client-side validation (legacy "required" asterisks were cosmetic; ratings were not clamped; a blank maturity silently became 1).
- Accepting an entity-shaped body (`@Body() body: any` / Prisma input types) or a free-text "owner" that is later compared with `includes('@')`.
- Silent coercion/clamping instead of an error; `implicit conversion` turning `"false"` into `true`.
- UTC "today" for business dates; timezone-less comparisons; `moment`-style truncating day diffs.
- Returning different error shapes per endpoint.

## Checklist
- [ ] Separate create/update/response DTOs; every field bounded; unknown properties rejected
- [ ] No tenant/audit/computed fields accepted; status changes via action endpoints
- [ ] Domain rules enforced in services/domain with typed `code`s (422/409 as appropriate)
- [ ] Dates: instants in UTC, date-only as `YYYY-MM-DD`, deadlines in the organisation timezone with an injected clock
- [ ] Lists paginated with allow-listed sort/filter fields
- [ ] Contract version bumped for any DTO/enum change; frontend Yup schema updated to match

## References
`src/common/pipes/validation.pipe.ts`, `src/common/filters/problem-details.filter.ts`, `src/config/env.schema.ts` (example of class-validator use), `backend-architecture`, `grc-domain`, frontend `forms-and-validation`.
