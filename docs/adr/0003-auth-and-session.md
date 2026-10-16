# ADR-0003: Authentication and session model

- **Status:** Accepted (implemented in Phase 2b)
- **Date:** 2026-10-14

## Context
The SPA calls the API from another origin. Tokens must not live where XSS can read them for long, and revocation or role changes must take effect immediately. Hosting (and therefore domains) is undecided (gate G0).

## Decision
- **Access token**: JWT, about 15 minutes, claims `sub` and `sid` only; held in memory by the SPA; sent as `Authorization: Bearer`.
- **Refresh token**: opaque 32-byte random value stored **hashed** with a family id; `HttpOnly; Secure; SameSite=Lax` cookie scoped to `/api/v1/auth`; **rotated on every use**, and reuse of a rotated token revokes the family. The SPA calls `POST /auth/refresh` on boot (single-flight).
- Session and membership are re-read from the database on each request.
- Passwords: **argon2id**. Verification, reset and invitation tokens: 32-byte CSPRNG, hashed, purpose-typed, single-use, expiring (24 h / 30 min / 7 days), **consumed by POST** from an SPA page (mail scanners prefetch GET links); uniform responses prevent enumeration; a reset revokes all sessions.
- Brute-force protection: Postgres-backed counters per account and IP with progressive delay; the throttler handles coarse per-IP limits. MFA is reserved (`auth_factor`, `amr`), TOTP first, mandatory for platform admins once built.
- CSRF applies only to the cookie endpoints: exact-origin CORS, `Origin` check, custom header.

## Phase 2b outcome (2026-10-15): what was built, and the refinements
- **Library**: `@node-rs/argon2` 2.2.2 instead of `argon2`: prebuilt binaries, **no install script** (`argon2` runs `node-gyp-build` on install, which needs an `allowScripts` decision and a toolchain on odd hosts). Argon2id is its default; a unit test asserts the `$argon2id$` prefix because its `Algorithm` enum cannot be used under `isolatedModules`. Cost parameters come from configuration (default m=19456 KiB, t=2, p=1).
- **Refresh grace window (not in the original decision)**: a rotated refresh token presented again within `REFRESH_REUSE_GRACE_SECONDS` (default 10) is treated as a concurrent request and answered with a fresh pair; later reuse revokes the whole session. Without it, restoring several tabs after a browser restart sends the same cookie from every tab and the reuse detector would sign the user out. Trade-off: a thief who replays a token within 10 s of the legitimate rotation is not detected by this mechanism.
- **Sessions** have an absolute lifetime (`REFRESH_TOKEN_TTL_DAYS`, 30): refreshing never extends it.
- **One-time tokens are created by the email job at send time**, not at request time: the raw token exists only in memory and in the message, never in the database or in a job payload (which carry the user id only). A retried job creates a fresh token and deletes unused ones, so only the newest link works. Links carry the token in the URL **fragment** so it never reaches servers, logs or Referer headers.
- **Lockout counters and security events hold keyed HMAC-SHA-256 hashes** of the address and the IP (key derived from the JWT secret), never the values, so attempts against non-existent addresses are counted (no enumeration) without storing those addresses.
- **Lockout policy**: 5 failures for one account, or 30 from one IP, inside 15 minutes; first lock 30 s, doubling to 15 minutes; a success resets the account count; locked attempts do not extend the lock; correct-password-but-unverified does not count as a failure.
- **Known limitation, pre-registration**: someone can register a victim's address before the victim does. The account stays unusable until the address is confirmed, a second registration never overwrites the stored password, and a successful password reset by the real owner (which proves the address and ends every session) replaces the attacker's password. The remaining hole is a victim who clicks the confirmation link of an account they did not create; the email says so explicitly. Expiring unconfirmed accounts is a later housekeeping job.
- **Known limitation, password denylist**: a bundled sample of very common passwords plus length and pattern rules, not a breach corpus. A k-anonymity range query to a breach service is a deliberate later decision (external call, privacy, availability).
- **Time zone**: Prisma's pg adapter sends timestamps without an offset, so the database session must run in UTC (Neon's default). `prisma/sql/runtime-role.sql` pins it for the runtime role and `test/database/session-timezone.int-spec.ts` checks it.

## Consequences
Works without third-party storage. **Risk**: if web and API are on different registrable domains the refresh cookie is third-party and blocked by Safari and Firefox. Gate G0 must choose same-site custom domains (for example `app.x.com` + `api.x.com`) or a host rewrite of `/api/*`. Local development (`localhost` ports) is same-site.

## Alternatives rejected
Tokens in `localStorage` (XSS), long-lived JWTs (no revocation), roles or organisation inside the JWT (stale after changes). Server-side sessions only remain a viable alternative if G0 forces a single origin.

## Revisit when
Hosting is chosen, or SSO/OIDC for enterprise customers is required.
