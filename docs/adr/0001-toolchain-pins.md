# ADR-0001: Toolchain pins and spike results

- **Status:** Accepted
- **Date:** 2026-10-14
- **Scope:** fca-backend (the frontend records its own pins in its ADR-0001)

## Context
Registry `latest` tags on 2026-10-14 were ahead of what the ecosystem supports: TypeScript 7.0.2 (native compiler, no stable programmatic API), Prisma CLI `latest` = 8.0.0-rc.22 (a release candidate) while `@prisma/client@latest` = 7.10.0, NestJS 12.1 (ESM-first), Vite 8.3, Vitest 5.0 and ESLint 10. Installing "latest" blindly would have produced an unsupported combination.

## Decision
Pin **exact** versions (`.npmrc`: `save-exact=true`, `engine-strict=true`; lockfile committed):

| Area | Pin | Why |
|---|---|---|
| Node | 24.x (`engines >=24.15.0`, `.nvmrc` 24) | Nest 12 CLI generators need Node >= 24.15 |
| TypeScript | **6.0.3** | TS 7 lacks a stable API: typescript-eslint peers `<6.1`, `@nestjs/swagger` supports `^5.5 or ^6`; revisit at TS 7.1 |
| NestJS | 12.1.3 core/common/platform-express/testing, cli 12.0.8, schematics 12.0.7, config 12.0.1, swagger 12.0.2 | ESM-first core |
| Prisma | `prisma`, `@prisma/client`, `@prisma/adapter-pg` all **7.10.0**; `pg` 8.23.1 | not the 8.0 RC; revisit when `@prisma/client@latest` is 8.x GA |
| Tests | **Vitest 4.1.11** (+ `@vitest/coverage-v8`), supertest 7.3.1 | Nest 12 template baseline; Vitest 5.0 exists but adds nothing we need yet (a deviation from the 5.0 originally planned) |
| Lint/format | **oxlint 1.88 `--type-aware`** (+ `oxlint-tsgolint` 7.0.2004), Prettier 3.9.10 | Nest 12 template default; `typescript/no-floating-promises` and `no-misused-promises` are errors |
| Logging/HTTP | nestjs-pino 5.3.1, pino 10.4.0, pino-http 11.0.0, helmet 8.3.0, class-validator 0.15.1, class-transformer 0.5.1 | peers verified |
| Installed in Phase 2b | @nestjs/jwt 12.0.3, @nestjs/throttler 6.7.1, **@node-rs/argon2 2.2.2** (replaces `argon2` 0.45.1: no install script) | verified on Windows: argon2id hash in about 24 ms at the default cost; `npm audit` unchanged (the 4 documented Prisma CLI findings) |
| Later phases | pdfmake 0.3.11, nodemailer 10.1.1, @nestjs/throttler 6.7.1, @nestjs/schedule 12.0.2, @nestjs/jwt 12.0.3 | verify the native install of argon2 on Windows in Phase 2b |

Module system: **ESM** (`"type": "module"`, `module: nodenext`, relative imports end in `.js`), the Nest 12 default.

## Spike results (Phase 0)
- **S1 passed**: Nest 12 ESM + Vitest 4.1 (DI and decorators, supertest e2e) + oxlint type-aware + `nest build` + Node ESM runtime import. Prisma 7.10 with the `prisma-client` generator (`moduleFormat = "esm"`, output `src/generated/prisma`) and `@prisma/adapter-pg` constructs lazily without a database. Finding: `env('DIRECT_URL')` in `prisma.config.ts` **throws when the variable is missing**, which would break `prisma generate` on a fresh clone; `datasource.url` is therefore set only when `DIRECT_URL` exists (generate works with no environment; `migrate` fails with Prisma's clear "datasource.url is required").
- **S2 (frontend)**: the Vite template (create-vite 9.2) ships **oxlint**, not ESLint: adopted (see frontend ADR-0001).
- **S3 passed**: `@rtk-query/codegen-openapi` 2.2.0 generated typed hooks from `contracts/openapi.json`.
- **S4**: `shadcn init --template vite --base radix --css-variables` (flags captured for Phase 1; `--base` accepts `base`, `radix`, `aria`).
- **S5 (Neon: pooled and direct URLs, interactive transaction + `set_config`, migration, shadow database): PASSED on 2026-10-15** (PostgreSQL 18.6, `fca_test`, pooled URL as the non-owner `fca_app`): `adapter-pg` works on the pooler, `set_config(…, true)` is visible inside the transaction and never leaks (12 concurrent tenants isolated), `migrate deploy` works on the direct URL and a no-change `migrate dev --create-only` shows no drift (the shadow database can be created). Details and the RLS outcome: [neon-setup.md](../neon-setup.md) section 6 and ADR-0004. Two Neon traps found while verifying it: unreachable resolved addresses stall new connections about 22 s (IPv4-first plus a 2 s attempt timeout fixes it), and Prisma interactive transactions wait only 2 s for a connection by default. Phase 2a findings that do not need Neon: Prisma 7.10 accepts `@default(uuid(7))`; `prisma migrate diff --script` needs a syntactically valid `DIRECT_URL` even offline; Prisma maps a trigger's SQLSTATE class 23 error to "Foreign key constraint violated" and hides the message.

## Consequences
- Exact pins make upgrades deliberate: each bump needs `npm run verify` and a note here.
- npm 11 reports install scripts not covered by `allowScripts`. Decisions are recorded in `package.json`: `prisma` and `@prisma/engines` allowed (needed to download the schema engine), `@scarf/scarf` (install telemetry) **denied**. `strict-allow-scripts=true` is a candidate hardening once Phase 2b adds argon2.
- `@nestjs/mau` and the `deploy` script from the Nest template were removed (not needed).

## Revisit when
TypeScript 7.1 ships a stable API and typescript-eslint and `@nestjs/swagger` support it; `@prisma/client@latest` reaches 8.x GA; Vitest 5 is required by a dependency.
