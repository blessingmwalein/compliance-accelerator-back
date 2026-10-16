---
name: security-and-rbac
description: Use when touching authentication, sessions, tokens, passwords, email verification, organisation membership, roles, permissions, guards, decorators, rate limiting, CORS/helmet, secrets or file-upload security in fca-backend. Normative source for the six-role permission model.
---

# Security and RBAC (backend, normative)

## When to use
Any new endpoint (it must declare access), any change to auth/session/guard code, any new permission or role rule, anything handling secrets or personal data. Frontend consumer obligations live in `fca-frontend/.claude/skills/security-and-rbac` and point back here.

## Rules

### Authentication and sessions (decided in ADR-0003; **built** in Phase 2b in `src/auth`, `src/security-events`, `src/jobs`, `src/mail`)
1. **Access token**: JWT, ~15 minutes, claims `sub` (user id) and `sid` (session id) only: no roles, no organisation. Sent as `Authorization: Bearer`; the SPA keeps it **in memory** only.
2. **Refresh token**: opaque 32-byte random value, stored **hashed** (SHA-256) with a *family id*; delivered in an `HttpOnly; Secure; SameSite=Lax` cookie scoped to `/api/v1/auth`. **Rotation on every use; reuse of a rotated token revokes the whole family**, except inside the `REFRESH_REUSE_GRACE_SECONDS` window (default 10), where it is a concurrent request (several tabs restoring) and gets a fresh pair. The session has an absolute lifetime (`REFRESH_TOKEN_TTL_DAYS`); refreshing never extends it. The SPA calls `POST /auth/refresh` on boot (single-flight). Tokens live in `refresh_tokens`, sessions in `sessions` (the session id is the family id and the `sid` claim).
3. Session **and** membership are re-read from the database on every request, so a revoked session, removed member or changed role takes effect immediately.
4. Passwords: **argon2id** via `@node-rs/argon2` (prebuilt, no install script; verified on Windows), random per-hash salt inside the PHC string, cost in config (`ARGON2_MEMORY_KIB`, `ARGON2_TIME_COST`). Rules in `src/auth/password-policy.ts`: 12 to 128 characters, no composition rules, a bundled sample denylist (NOT a breach corpus), repeated/sequential strings including wrapping digit runs, must not contain the email name. Never log or return hashes. `PasswordService.verifyDummy` spends the same time for unknown accounts.
5. **Email verification, password reset and invitation tokens**: 32-byte CSPRNG, **stored hashed**, purpose-typed, single-use, expiring (24 h / 30 min / 7 days). They are *consumed by a POST from an SPA page*, never by a GET link handler: mail scanners and link previewers prefetch GETs. Responses are uniform (no account enumeration). A reset revokes all sessions.
6. **Brute force** (`src/auth/lockout.ts`, `login_attempts`): Postgres-backed counters per account (5 failures) and per IP (30) in a 15-minute window, locks of 30 s doubling to 15 min with `Retry-After`, keyed on **keyed hashes** (`KeyedHasher`) of the address and IP so unknown addresses count too and no raw address is stored; a dummy hash on unknown accounts (constant-ish timing). In-memory throttlers are not enough on serverless/multi-instance hosts. `@nestjs/throttler` handles coarse per-IP limits.
7. CSRF: only cookie endpoints (`/auth/refresh`, `/auth/logout`) are exposed to it. Require exact-origin CORS, an `Origin` check, and a custom header (`X-Requested-With`/`Idempotency-Key`-style) on them.
8. MFA is **reserved** (`auth_factor` table, `amr` claim); TOTP first, mandatory for platform admins once available.
9. **Hosting gate (G0)**: the refresh cookie is first-party only if web and API share a registrable domain (e.g. `app.x.com` + `api.x.com`) or the host rewrites `/api/*` to the API. Different registrable domains ⇒ third-party cookie ⇒ blocked by Safari/Firefox. Local `localhost` ports are same-site and fine.

### Tenant and role resolution
- Tenant routes are `/api/v1/organisations/:organisationId/…`. the global `AccessGuard` (`src/access`) verifies an **active membership** for `(user, organisationId)` through a SECURITY DEFINER lookup and only then writes organisation, membership and role to the request scope (`RequestContext`); the verified membership also rides on the request (`OrganisationRequest`) for `GET …/me`. Non-tenant routes: `/auth/*`, `/me`, catalogues (`/frameworks`, `/plans`), `/platform/*`.
- One user may belong to several organisations (one active membership per organisation); the SPA selects the active one. (The legacy app allowed one company per user.)

### Roles and permissions (the six roles you chose)
Roles (system roles, fixed in v1): **Company Owner, Company Admin, Compliance Manager, Course Administrator, Standard User, Read Only**. The **DPO is a designated contact** on the organisation (name/email in Company Settings) that receives breach/DSAR alerts: it is *not* a role, and may be an external address.

- Permissions are `module.action` strings in a typed catalogue (`src/permissions/catalogue.ts`): actions `view`, `create`, `edit`, `delete`, plus `approve`, `export`, `assign`, `manage` where needed. Roles are named bundles; the matrix is documented in `docs/rbac-matrix.md` (derived from the legacy matrix; additions marked) and rendered from the catalogue. The catalogue is emitted into OpenAPI as `x-permission` so the frontend and tests can read it.
- **Deny by default**: the guards are global (`APP_GUARD`, in this order: throttler, `AuthGuard`, `AccessGuard`; `test/access-declaration.e2e-spec.ts` proves the order by behaviour). Every handler declares **exactly one** of `@Public()` (health, meta, auth bootstrap), `@Authenticated()` (any signed-in user, no organisation), `@RequirePermission('x.y')` (an ACTIVE member whose role holds the key), `@OrganisationMember()` (any ACTIVE member) or `@PlatformOnly('platform.…')` (`src/auth/access.decorators.ts`); the test fails for none or several, a handler with none is denied (403) at runtime, and each decorator writes `x-access` / `x-permission` into the contract. The permission keys are the typed catalogue in `src/permissions/catalogue.ts` (docs/rbac-matrix.md is checked against it by a test).
- Record-level rules (e.g. "Standard User may edit only tasks assigned to them") will live in a `@Policy(PolicyClass)` evaluated after the permission check, never in controllers: **not built yet** (the first module that needs one, Phase 5, adds it). No business-unit-scoped access in v1 (extension point only).
- **404 vs 403**: not a member / foreign or unknown id ⇒ 404; member lacking the permission ⇒ 403 *before* any lookup; an owner-only action by an admin ⇒ 403.
- Never trust a role, organisation or user id supplied by the client.

### Membership administration (built in 2c)
- Only an Owner grants, changes or removes the Owner role (`403 OWNER_ONLY`, `mayAssignRole`); nobody changes their own role or deactivates themselves (`403 SELF_CHANGE_NOT_ALLOWED`); an organisation always keeps one active Owner (`409 LAST_OWNER`): the active owners are locked (`SELECT … FOR UPDATE`) before the check so two concurrent demotions cannot both pass.
- Changes carry the member's `version` (optimistic locking, `409 VERSION_CONFLICT`) and are audited in the same transaction. Denials are **logged, not stored** (an audit row per 403 would let any member flood the trail).
- Invitations are offers to an email ADDRESS: the token is created by the email JOB at send time (only its SHA-256 is stored, replaced on every send, cleared when spent), the link is `/accept-invitation#token=…`, accepting is a POST by the signed-in account whose CONFIRMED address was invited; every unusable token gives one uniform `INVALID_TOKEN`. One pending invitation per address (partial unique index); an expired one is replaced, not blocking.

### Platform administration (assumption: confirm with the owner)
A `platform_admin` flag on the user (outside the six roles, like Base44's system `admin`) may call **only** `/api/v1/platform/*` (plan catalogue and **plan visibility**, organisation provisioning/suspension). It **never** passes the organisation checks of `AccessGuard` and never reads tenant data (it lists names and counts through a SECURITY DEFINER function); it is granted only with `npm run platform-admin -- grant <email>` (owner database credentials, writes a security event), never through the API; support access, if ever needed, is an owner-granted, time-boxed, audited grant. Mandatory MFA once MFA exists. If the owner drops this concept, plan visibility becomes an Owner-level company setting.

### Plans, entitlements, visibility
Plan **visibility** (what is shown), commercial **availability**, **entitlements** (what an organisation may use: per-organisation snapshot, `@RequireEntitlement`) and **billing** are four separate things. Hiding a plan changes visibility only and never revokes an existing organisation's entitlements.

**Built in Phase 3** (`src/plans`, `src/organisations/entitlements.*`): assigning a plan COPIES its limits into `organisation_entitlements` (a snapshot), so later edits to the plan never reach organisations that already have it; **no plan = no limits** (never "0"); the user limit counts active members plus open invitations and is checked inside the invite and reactivate transactions (`403 USER_LIMIT_REACHED`); the seeded plans are **placeholders** (`is_placeholder`) until the owner confirms them. `@RequireEntitlement` is NOT built yet: add it with the first feature entitlement and keep enforcing in the service, never only in the UI.

### Transport, headers, input, files
- `helmet` defaults, exact-origin CORS with credentials (no `*`), JSON body size limit, `X-Request-Id` correlation, structured logs with `authorization`/`cookie`/`set-cookie` redacted.
- Validation: global `ValidationPipe` with `whitelist` + `forbidNonWhitelisted` (mass-assignment guard). Output encoding is the client's job; the API never reflects raw HTML.
- **Logos** (Phase 3, `src/settings` + `src/storage`): PNG or JPEG only (recognised by their bytes, never by `Content-Type` or file name; no SVG), 512 KiB cap, stored through `StorageProvider` under an opaque key, served only through the authorised endpoint with `ETag`, `Cache-Control: private, no-cache`, `nosniff` and a locked-down CSP. A logo change does not bump the organisation `version`.
- **Uploads** (evidence): allow-list of types, **magic-byte sniffing** (never trust `Content-Type` or extension), size cap, no SVG/HTML/executables/archives, server-side SHA-256, private storage, authorised proxied download with `Content-Disposition: attachment` + `nosniff`, optional virus scan (`pending_scan|clean|infected|not_scanned`; production fail-closed).
- **Secrets**: only from environment variables, never committed, never logged, never in OpenAPI examples. `.env` is git-ignored; `.env.example` documents keys without values.
- **Audit**: authentication events, permission denials worth recording, membership/role changes, exports, deletions, settings changes (see `backend-architecture`: same transaction, fail-closed, immutable).
- Personal data minimisation: logs, emails (link-only bodies), AI prompts and error messages never contain DSAR subject details or breach specifics.

## Example

```ts
@Controller('organisations/:organisationId/ropa')
export class RopaController {
  @Get(':id')
  @RequirePermission('data.view')                 // checked by the global AccessGuard
  @ApiProblemResponse(HttpStatus.NOT_FOUND, 'Not found in this organisation.')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.get(id);                  // service/repo scope by TenantContext; foreign id => 404
  }
}

@Public()                                         // explicit opt-out of authentication
@Get('health')
getHealth() { /* ... */ }
```

## Anti-patterns
- Client-side-only permission checks (the legacy sidebar hid links but the data stayed reachable); a platform `admin` that bypasses every tenant check; two `useAuth` hooks; role sets that disagree between code and docs.
- Roles or organisation ids inside the JWT (stale after a change); long-lived access tokens; tokens in `localStorage`; refresh tokens stored in plain text; GET endpoints that consume one-time tokens.
- `if (user.role === 'admin') return true` style bypasses; ad hoc `if (role === …)` checks in services instead of permissions/policies.
- Email delivery limited to registered users (the DPO or an invitee may not be a user); plan names hard-coded in guards.
- Logging bodies/tokens; returning 403 for a foreign tenant's record (confirms existence).

## Checklist
- [ ] Handler declares `@RequirePermission` / `@Public` / `@PlatformOnly` (+ entitlement if plan-gated)
- [ ] New permission added to the catalogue, `docs/rbac-matrix.md` updated, role bundles reviewed
- [ ] Foreign/unknown ids give 404; missing permission gives 403 before lookup
- [ ] Security-relevant action is audited in the same transaction
- [ ] No tenant/role/user id accepted from the client; DTO whitelist active
- [ ] Tenancy matrix and RBAC matrix tests cover the endpoint (auto-generated; see `testing-and-quality`)
- [ ] Secrets only via env and `.env.example` updated; no sensitive data in logs/emails

## References
ADR-0003 (auth/session), ADR-0004 (tenancy), ADR-0005 (RBAC), `docs/rbac-matrix.md`, `docs/security-baseline.md`, `database-and-tenancy`, `notifications-and-jobs`.
