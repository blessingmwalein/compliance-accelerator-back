# Deploying the API on Vercel (Node.js function) + Supabase Storage + Neon

The API is a NestJS application, not a Next.js one, and it stays that way. Vercel runs it as a single Node.js
serverless function: `npm run build` compiles the app to `dist/`, [../api/index.mjs](../api/index.mjs) re-exports
the handler built by [../src/main-serverless.ts](../src/main-serverless.ts), and [../vercel.json](../vercel.json)
routes every path to that one function. No route, guard, filter or header is re-implemented for the serverless
path — `configureApp` is the only HTTP surface and it is shared with `npm run start` and the e2e tests.

**Nothing in this file is deployed for you.** The Vercel project, the Supabase bucket and the Neon branch are the
owner's to create; the code, the config and the checks are here.

## What the deploy needs from each host

| Concern | Host | Why |
|---|---|---|
| Rows, tenancy, audit trail, the job ledger | Neon (Postgres) | unchanged: the pooled connection string is what the app uses |
| Uploaded evidence, report PDFs, the logo | Supabase Storage over its S3-compatible endpoint | a function's filesystem is read-only except `/tmp`, and `/tmp` may be wiped between two requests (ADR-0007) |
| HTTP | Vercel Node 24 function | `engines.node` is `>=24.15.0`; Vercel's default runtime satisfies it |
| Running queued jobs | nothing yet | see "Jobs do not run" below |

## Before the first deploy

1. **Neon.** Use the branch you want the deployment to write to and copy its **pooled** connection string (the
   host contains `-pooler`). Step by step: [neon-setup.md](neon-setup.md). Migrations are applied by the owner
   with `npm run db:migrate:deploy` — never by the deployed app.
2. **Supabase Storage.** In the project's Storage settings: create one **private** bucket (e.g. `fca-files`),
   then create an S3 access key ("S3 compatibility"). Write down the endpoint
   (`https://<project-ref>.storage.supabase.co`), the **region shown with those keys** and both key values.
   The app never creates a bucket and never lists one: it only writes the keys the database already names —
   `org/{organisationId}/evidence/…`, `org/{organisationId}/reports/{reportId}`, `org/{organisationId}/logo/{uuid}`.
3. **Vercel.** Import the repository with **Root Directory = `fca-backend`**. The framework preset is "Vercel
   Node.js" (`framework: null` in `vercel.json`), the Build Command is `npm run build`, and `npm ci` runs
   `prisma generate` through its `postinstall`, so the generated client is built on the CI machine and never
   committed.

## Environment variables

Every key is listed in [../.env.example](../.env.example) with its meaning; `npm run check:docs` fails if a key
the code reads is missing from it. For a deployment the short list is:

| Key | Value on Vercel | Note |
|---|---|---|
| `NODE_ENV` | `production` | what makes the boot checks below apply |
| `DATABASE_URL` | Neon **pooled** string | the app connects lazily; `/health/ready` says `DATABASE_NOT_CONFIGURED` without it |
| `DIRECT_URL` | **not set** | only the Prisma CLI uses it, and migrations do not run in a function |
| `JWT_ACCESS_SECRET` | ≥32 random chars, unique per environment | never committed, never logged |
| `CORS_ORIGINS` | the deployed web origin, exact | no wildcards, no paths |
| `APP_BASE_URL` | the web app origin | the base of every link in every email |
| `TRUST_PROXY` | `1` | without it the per-IP limits and the lockout counters key on Vercel's address, not the visitor's |
| `COOKIE_SECURE` | empty (= `true` in production) | the refresh cookie is `HttpOnly`, `SameSite=Lax`, scoped to `/api/v1/auth` |
| `STORAGE_DRIVER` | `s3` | `local` in production is refused at boot: the disk it would write to can be discarded |
| `STORAGE_S3_ENDPOINT` | `https://<project-ref>.storage.supabase.co` | scheme and host only — no path, no credentials, no query |
| `STORAGE_S3_BUCKET` | the private bucket's name | created by you, never by the app |
| `STORAGE_S3_REGION` | the region shown with the S3 keys | the signature is scoped to it |
| `STORAGE_S3_ACCESS_KEY_ID` / `STORAGE_S3_SECRET_ACCESS_KEY` | the Supabase S3 key pair | the secret is only ever used to sign requests to the endpoint above |
| `EVIDENCE_MAX_BYTES` | empty (= 4 MiB) | the cap `GET /api/v1/meta` states as `evidenceMaxBytes` |
| `JOBS_TICK_SECRET` | empty until a scheduler exists | with a value, `POST /api/v1/internal/jobs/tick` accepts HMAC-signed runs |
| `SWAGGER_ENABLED` | empty (= off in production) | the raw document is published as `contracts/openapi.json`, not served |

Total environment size is capped by the host (64 KB); the connection strings and the key pair fit comfortably.

## First checks after a deploy

```bash
curl -s https://<api-host>/api/v1/health          # 200, { "status": "ok" }
curl -s https://<api-host>/api/v1/health/ready    # 200 with a live database, 503 + DATABASE_* otherwise
curl -s https://<api-host>/api/v1/meta            # contractVersion 0.10.0, evidenceMaxBytes 4194304
```

Then the two things the platform can prove and a log line cannot: sign in through the deployed web app, and
upload an evidence file. The upload is the storage test — a wrong endpoint, region, key or bucket name fails
there, and the object appears in the bucket under `org/{organisationId}/evidence/…`. If the bucket shows the
object and the download endpoint returns bytes with the same `ETag`/`sha256`, persistence is real.

## What a function host changes, stated plainly

- **Bodies are capped at 4.5 MB in and out.** Vercel rejects a larger request before the application sees it,
  with its own error rather than this API's `problem+json`. That is why the upload default is 4 MiB, and why
  `GET /meta` states the number: a client that quoted 10 MiB would be describing a limit the host had already
  broken. A 5 MB PDF download also does not fit; large exports need pre-signed URLs, which this build does not
  issue.
- **Jobs do not run.** Outside development `JOBS_RUNNER` defaults to `external` and a function is not executing
  between requests, so nothing is ticked: alert emails, DSAR deadlines and report renders stay queued in the
  `jobs` table. No scheduler is configured yet — the owner's decision for this deployment was to accept that.
  When a cron is added it calls `POST /api/v1/internal/jobs/tick` with `JOBS_TICK_SECRET`; until then the
  endpoint is disabled (404) and the ledger is honest about what was never sent.
- **No email is delivered.** `MAIL_TRANSPORT` still has one value, `file`, and a function's disk is not a
  mailbox. This is the gate G0 decision it has always been, not a regression of this deploy.
- **Requests must finish inside the duration limit** (`maxDuration: 300` in `vercel.json`). Report generation is
  synchronous today and a single assessment cycle fits; the async report path (Phase 9a) is what makes a long
  document someone else's job.
- **Only `/tmp` is writable** (500 MB per instance, not shared, not kept). Uploaded bytes go to the object store
  and PDFs are rendered in memory; nothing in the app depends on a file surviving to the next request.
- **Rate limits are per instance.** The throttler counts in memory, so a warm instance enforces its own budget;
  the account lockout counter is keyed in Redis-free Postgres and is therefore global, but a burst spread over
  cold starts sees a fresh counter each time. Per-instance counting is a known, accepted weakness of this shape
  and the reason the login route's stricter limit is not the only defence.
- **Cold start is the first request only.** Booting the module tree and generating the OpenAPI document takes
  seconds; the instance is reused after that. Keep one deployment warm by using it.
- **Web and API must be same-site** for the refresh cookie: `fca-web.vercel.app` and
  `fca-api.vercel.app` share the registrable domain `vercel.app`, so `SameSite=Lax` lets the cookie travel on
  the top-level navigation and on same-site XHR. Two different registrable domains cannot refresh a session.

## Rollback

A deployment is immutable, so "rollback" is promoting the previous one from Vercel's Deployments list. The
database is not part of it: a rollback does not undo an applied migration, and an object left in the bucket by a
superseded upload is addressed by the row that names it, so nothing outside the database needs cleaning.
