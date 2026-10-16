# Security baseline

Controls the platform must have, the phase that delivers each, and how it is verified. Rules for engineers live in the `security-and-rbac`, `database-and-tenancy` and `backend-architecture` skills. Status: **[done]** = built and tested in the repository; **[built]** = built, with the database-backed checks passed on Neon (`npm run test:int` on `fca_test` as the non-owner runtime role, 2026-10-15); otherwise planned.

| # | Control | Phase | Verification |
|---|---|---|---|
| 1 | Validated configuration; the app fails fast on invalid or missing production settings (`CORS_ORIGINS`, `DATABASE_URL`) | **[done]** 0 | unit |
| 2 | RFC 9457 errors; no stack traces, SQL or secrets in responses | **[done]** 0 | unit/e2e |
| 3 | `helmet` headers, exact-origin CORS with credentials, framework banner hidden | **[done]** 0 | e2e |
| 4 | Request correlation id, log redaction of `authorization`, `cookie`, `set-cookie` | **[done]** 0 | e2e/unit |
| 5 | Global `ValidationPipe`: whitelist, forbid unknown properties, no implicit conversion | **[done]** 0 | e2e |
| 6 | Secrets only via environment; `.env` git-ignored; `.env.example` documents keys; docs check | **[done]** 0 | `check:docs` |
| 7 | Tenant isolation layers (guard, scoped repositories, `$extends` net, composite FKs, RLS) | **[built]** 2a/2c | generated tenancy matrix + catalogue test + RLS integration spec |
| 8 | Append-only audit log written in the same transaction; DB-level immutability | **[built]** 2a (also `security_events`, 2b) | unit + integration |
| 9 | Authentication: argon2id, short access token, rotating refresh cookie with reuse detection | **[built]** 2b | unit + e2e + integration |
| 10 | Single-use, hashed, expiring verification/reset/invite tokens consumed by POST (invitations: built in 2c) | **[built]** 2b/2c | unit + integration |
| 11 | Brute-force protection (DB-backed counters) and per-IP throttling; uniform auth responses | **[built]** 2b | unit + e2e + integration |
| 12 | Deny-by-default authorisation; permission catalogue; `404` for foreign records | **[built]** 2c | generated RBAC + tenancy matrices |
| 13 | Upload hardening: allow-list, magic bytes, size cap, SHA-256, private storage, authorised audited downloads, optional AV | 3 (logo) / 5 / 7 | integration |
| 14 | Idempotency keys on creates; optimistic concurrency | 2a | integration |
| 15 | Job tick endpoint authenticated by HMAC with timestamp window | **[built]** 2b | unit + e2e + integration |
| 16 | Personal-data minimisation: no DSAR/breach details in logs, emails, job payloads or AI prompts | all | review + tests |
| 17 | Dependency hygiene: exact pins, lockfile, `npm audit` review, `allowScripts` approvals (see "Accepted audit findings" below) | 0 → ongoing | review |
| 18 | MFA (TOTP), mandatory for platform admins | after 2c | integration |
| 19 | Encryption: TLS everywhere; Neon encryption at rest; field-level encryption for DSAR/breach PII evaluated | 7 | design review |
| 20 | Backups, point-in-time recovery, restore drill; tenant export/offboarding procedure | 11 | drill |
| 21 | Security review (OWASP ASVS pass), penetration test, secret scanning in CI | 11 | report |

## Accepted audit findings (reviewed 2026-10-14)
`npm audit` reports **4 high** findings in the backend and **0** in the frontend. All four sit in the transitive dependencies that `prisma@7.10.0` (the CLI, a devDependency) pins exactly:

| Package (via) | Advisory | Why it is not reachable here |
|---|---|---|
| `mysql2` 3.15.3 (`prisma`) | auth-plugin downgrade leaks credentials; decompression-bomb DoS in the compressed MySQL protocol | MySQL only; this project uses PostgreSQL and never loads a MySQL connection |
| `deepmerge-ts` 7.1.5 (`@prisma/config`) | stack exhaustion on recursive object graphs | only merges our own trusted `prisma.config.ts`; no attacker-controlled input |

`npm audit fix --force` would "fix" it by downgrading to `prisma@6.19.3`, which is wrong for this stack. The affected range includes Prisma 8.x development builds, so no patched release exists yet. **Not overridden on purpose:** forcing newer versions of dependencies that Prisma pins exactly cannot be validated until migrations run against Neon (spike S5), and silently breaking the migration tooling is the larger risk. Revisit after S5 or when Prisma publishes a fixed release; a CI gate on `npm audit` must allow-list these advisories until then.

## Threat notes
- **Cross-tenant access** is the top risk: mitigated by layered tenancy and a generated matrix that probes every route.
- **Token theft**: access tokens are short-lived and memory-only; refresh tokens rotate with family revocation; cookies are `HttpOnly`.
- **Mail-scanner prefetch** consuming one-time links: tokens are consumed by POST from an SPA page.
- **Malicious uploads**: magic-byte sniffing, no active content types, attachment disposition, `nosniff`.
- **Legal misinformation**: no unverified legal text ships (`compliance-frameworks`); reports and UI carry the informative-only disclaimer.
- **Insider/support access**: platform admin has no tenant data access; any support grant is owner-initiated, time-boxed and audited.
