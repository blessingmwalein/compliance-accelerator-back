# fca-backend

REST API for **Fernando Compliance Accelerator™ (FCA)**, a multi-tenant Governance, Risk & Compliance platform for data-protection programmes (CDPA, POPIA, GDPR, BDPA, ISO 27701, NIST CSF).

- Stack: Node 24, TypeScript 6, NestJS 12 (ESM), Prisma 7 + PostgreSQL on Neon, Vitest, oxlint.
- The web app lives in the separate repository **fca-frontend**. The two are connected only by the OpenAPI contract ([contracts/openapi.json](contracts/openapi.json)).
- Status: **Phases 0, 2a–2c, 3, 4, 5, 6, 7, 8 built and 9a built on the backend, contract 0.13.0**: health, meta, the error model, the tenancy foundation (request scope, tenant safety net, audit trail), authentication (`/auth/*`, `/me`), the jobs outbox and email (file transport), organisations, members, invitations, the permission catalogue and access guard, platform provisioning and row-level security (2c); company settings, business units, framework selection, plans and entitlements (3); the framework reference guide, governance areas and compliance mappings (4); the assessment cycle, scoring policy, Eisenhower priority, remediation tasks, evidence and the Governance Assessment PDF (5); the five registers — risk with its acceptance ledger and 5×5 heatmap, data classification, RoPA, lawful basis, and retention with legal holds and the disposal log (6); incidents and rights — the DSAR tracker with its SLA metric, the breach registry with its notification-decision ledger, the evidence repository (versions, review, attested scans), reminders with per-member preferences, the organisation's own deadline policy and the alert ledger that records who was told (7); and the executive dashboard — `GET …/dashboard/{summary,frameworks,gap-analysis,top-risks}` for the organisation-wide maturity, exposure, framework-coverage, gap and top-risk metrics (each stated as an availability before a value), heat-map drill-down filters on the risk list, the Executive Dashboard PDF from the same payloads, and `POST …/dashboard/ai-assessment`, which answers `503 FEATURE_UNAVAILABLE` until Phase 10 builds it (8); and the report surface with the audit trail (9a) — `GET …/reports/catalogue` served from the template registry, `GET …/reports` as history, `POST …/reports/consolidated-dpo` queued through the `report.generate` job and polled on `GET …/reports/{id}`, the seven-section Consolidated DPO Report, and `GET …/audit` with its CSV export. 0.10.0 is the deployment work rather than a phase: the API runs as one Vercel Node 24 function, files go to S3-compatible object storage (Supabase Storage), and the upload ceiling is a number the server states on `GET /meta` — see [docs/deployment-vercel.md](docs/deployment-vercel.md). Framework legal content and the seeded assessment templates wait for a named person to verify them. The Phase 5 template rows, the Phase 6 register tables and the Phase 7 incident tables were **applied to dev on 2026-10-18** (with `npm run db:apply-runtime-role` straight after), so those routes answer normally; **Phase 8 and the deployment add no migration** — every figure the dashboard shows is already stored. **Phase 9a needs `20261019120000_phase9a_report_generation`** (the `reports` columns a queued document needs) **and the classification register needs `20261020120000_classification_tier_and_posture`** (the tier, exposure posture, retention period and encryption flag the sample's Data Classification page reads), both authored offline and applied by the owner; until the first is applied the report **generation** routes answer `500 INTERNAL_ERROR` while the catalogue, the history and the audit routes only read and work normally, and until the second is applied **every** classification route fails, because the columns it selects are not there yet. The seeded template rows still carry the migration's `<VERIFYING-PERSON-NAME>` verifier, which is the owner's to name. No Phase 3–9a code ships new automated tests (owner decision); `npm run verify` covers lint, format, types, the existing suites, the build and the contract. Features arrive phase by phase: see [docs/implementation-plan.md](docs/implementation-plan.md).

> FCA supports a compliance programme; it does not provide legal advice or guarantee compliance with any law.

## Prerequisites
- Node.js 24 (`.nvmrc`), npm 11.
- A [Neon](https://neon.tech) project for anything database-backed (see [docs/neon-setup.md](docs/neon-setup.md)). The API starts and serves `/health`, `/meta` and the docs **without** a database.

## Quick start
```powershell
npm ci                    # also runs `prisma generate` (needs no environment)
Copy-Item .env.example .env   # then edit; never commit .env
npm run start:dev         # http://localhost:3001  ·  docs: http://localhost:3001/api/docs
```
Check it: `curl http://localhost:3001/api/v1/health` and `curl http://localhost:3001/api/v1/meta`.
`/api/v1/health/ready` returns `503 DATABASE_NOT_CONFIGURED` until `DATABASE_URL` is set.

## Scripts
| Script | Purpose |
|---|---|
| `npm run start:dev` / `start:prod` | run with watch / run the built app (`dist/main.js`) |
| `npm run verify` | **everything that must pass**: lint, typecheck, unit, e2e, build, contract check, docs check |
| `npm test` · `npm run test:e2e` | unit (+ catalogue and architecture checks) · HTTP tests (no database) |
| `npm run test:int` · `verify:full` | integration tests on the Neon `test` branch (destructive, guarded; **fail** when Neon is not configured) · `verify` + `test:int` |
| `npm run lint` · `typecheck` · `format` | oxlint (type-aware) · `tsc --noEmit` · Prettier |
| `npm run openapi:export` · `openapi:check` | write / verify `contracts/openapi.json` |
| `npm run db:generate` · `db:migrate:dev` · `db:migrate:deploy` · `db:status` | Prisma (CLI uses `DIRECT_URL`) |
| `npm run check:docs` | validates skills, CLAUDE.md, `.env.example`, links |
| `npm run seed:dev` | creates or refreshes the **demo company** in the dev database (six role accounts, units, settings; needs the direct `DIRECT_URL`; `-- --owner you@example.com` also makes your account an Owner; see [neon-setup.md](docs/neon-setup.md) section 7) |
| `npm run frameworks:status` · `frameworks:extract -- <nist or gdpr>` · `frameworks:verify -- <pack> --by "Name"` · `frameworks:load` | framework content packs: extract from a primary source, a NAMED PERSON verifies, the owner loads (direct `DIRECT_URL`); see [neon-setup.md](docs/neon-setup.md) section 8 |
| `npm run platform-admin -- grant <email>` | grants the platform flag to a registered account (owner credentials, direct URL) |

## Ports and URLs (local)
| What | URL |
|---|---|
| API | `http://localhost:3001/api/v1` |
| Swagger UI / JSON | `http://localhost:3001/api/docs` · `/api/docs-json` |
| Web app (CORS origin allowed by default) | `http://localhost:5173` |

## Configuration
All variables are documented in [.env.example](.env.example); the ones read today are validated at startup by `src/config/env.schema.ts` (the app refuses to start with an invalid configuration, and in production requires `CORS_ORIGINS`, `DATABASE_URL` and `APP_BASE_URL` explicitly). Reserved keys for later phases are listed commented-out.

**First run:** copy `.env.example` to `.env` and set `JWT_ACCESS_SECRET` (at least 32 random characters, no default: `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`). Set `JOBS_TICK_SECRET` only if a host scheduler will call the tick endpoint. With `MAIL_TRANSPORT=file` (the only transport until a provider is chosen) no email is delivered: confirmation, reset and deadline-alert messages are written to `.dev-mail/` as `.eml` files and the link is printed in the API log. An alert's deep link is `APP_BASE_URL` + the page + `?open=<recordId>`, so set `APP_BASE_URL` to the web origin (`http://localhost:5173` locally) or the links in the dev mail will point at the API. Without a database the API still starts (`/health` is 200, `/health/ready` and the auth endpoints answer 503 `DATABASE_UNAVAILABLE`).

## Database (Neon)
Two connection strings per Neon branch: **pooled** (`DATABASE_URL`, used by the app) and **direct** (`DIRECT_URL`, used only by the Prisma CLI). Use the `dev` branch for development and a separate `test` branch for integration tests. Step-by-step: [docs/neon-setup.md](docs/neon-setup.md).

## Documentation map
| Doc | Content |
|---|---|
| [CLAUDE.md](CLAUDE.md) | rules and workflow for Claude Code (read first) |
| [docs/architecture.md](docs/architecture.md) | layering, tenancy, auth, RBAC, audit, errors, jobs, storage, reports, deployment options |
| [docs/implementation-plan.md](docs/implementation-plan.md) | phases, slices, endpoints, status |
| [docs/acceptance-criteria.md](docs/acceptance-criteria.md) | Definition of Done and per-module criteria |
| [docs/integration.md](docs/integration.md) | how the frontend consumes this API (URL, auth, ports, contract version) |
| [docs/deployment-vercel.md](docs/deployment-vercel.md) | running the API as a Vercel function: Supabase Storage, the environment, what a function host changes |
| [docs/security-baseline.md](docs/security-baseline.md) | security controls and their phase |
| [docs/rbac-matrix.md](docs/rbac-matrix.md) | six roles × permissions (proposed, for review) |
| [docs/metrics/README.md](docs/metrics/README.md) | metric definition sheet template and list |
| [docs/frameworks/source-registry.md](docs/frameworks/source-registry.md) | authoritative sources and verification status |
| [docs/adr/](docs/adr/) | architecture decision records |
| [docs/reference/legacy-findings.md](docs/reference/legacy-findings.md) | business rules and anti-patterns found in the legacy app |
| [.claude/skills/](.claude/skills/) | nine project skills (architecture, tenancy, security, validation, domain, testing, reports, jobs, frameworks) |

## Connecting a remote repository
This repository is initialised locally (`main` branch) with **no remote and no commits**. To publish it:
1. Create an **empty** repository on your Git host (GitHub, GitLab, Azure DevOps…) named `fca-backend`. (The `gh` CLI is not installed here; use the host's web UI or install it.)
2. `git remote add origin <url>`
3. Review `git status`, make the first commit (`git add -A` then `git commit`), then `git push -u origin main`.
4. Repeat separately for `fca-frontend`. Do **not** combine the two into one repository.
5. Add CI later (lint, typecheck, tests, `npm run verify`); the workflow file depends on the host chosen at gate G0.
Never push `.env`; it is git-ignored on purpose.



Email	Role
owner@demo.example.test	Company Owner (the only role that can change the logo and display name)
admin@demo.example.test	Company Admin
manager@demo.example.test	Compliance Manager
courses@demo.example.test	Course Administrator
standard@demo.example.test	Standard User
readonly@demo.example.test	Read Only