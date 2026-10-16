# ADR-0006: Background jobs and notifications

- **Status:** Accepted (built in Phase 2b)
- **Date:** 2026-10-14

## Context
Hosting is undecided and the database is Neon (scale-to-zero). Reminders, overdue alerts, report generation and recalculations must not be lost, duplicated or tied to an always-on process.

## Decision
- **Transactional outbox + lease runner** in our own schema (`jobs`, `scheduled_jobs`): enqueue inside the domain transaction; claim with `FOR UPDATE SKIP LOCKED`; retries with backoff; dead-letter; unique `dedupe_key`; idempotent handlers (at-least-once).
- Two drivers over the same code: an **in-process poller** and an **HMAC-signed `POST /api/v1/internal/jobs/tick`** called by host cron (bounded batch), so serverless hosts work.
- `EmailProvider` interface: a **file transport** in development and test (`.eml` files plus the logged link; there is no Docker or Mailpit), SMTP/ESP in production (chosen at G0). `email_deliveries` is keyed on the recipient address; email bodies are link-only.
- Rejected: **pg-boss** (always-on worker, owns a schema, polling blocks Neon scale-to-zero) and **BullMQ/Redis** (extra infrastructure).
- A `JobQueue` interface keeps a later swap possible.

## Phase 2b outcome (2026-10-15)
- Built as decided: `jobs` outbox (partial indexes for the claim query), `FOR UPDATE SKIP LOCKED` claim that also reclaims expired leases, exponential backoff (30 s doubling, capped at 1 h, plus or minus 20 % jitter), dead letters, a lease owner check on completion (a worker that lost its lease cannot overwrite a newer attempt), a job whose lease expired on its last allowed attempt is dead-lettered instead of looping, errors stored sanitised (no addresses, no token-like strings), per-job failure isolation, tenant jobs run inside their organisation scope as the system actor.
- Handlers are discovered by scanning providers for `@JobHandler(type)` (two handlers for one type fail the boot); a job with no handler is dead-lettered.
- The tick endpoint is **excluded from the OpenAPI contract** (it is operational, not a client API) and documented in `docs/integration.md`: `X-FCA-Timestamp` + `X-FCA-Signature` (HMAC-SHA256 of `timestamp.POST.path`), 5-minute window, 404 when `JOBS_TICK_SECRET` is unset.
- The in-process poller runs only when `JOBS_RUNNER=inproc` (default in development), never in tests, and backs off exponentially when the database is unreachable instead of flooding the log.
- **Deferred**: `scheduled_jobs` (recurring definitions) until the first recurring job exists (Phase 7 reminders); SMTP/ESP until gate G0 (only the file transport exists, nothing is delivered); housekeeping jobs for `login_attempts` retention and expired tokens.

## Consequences
Hand-rolled retry, backoff and dead-letter logic must be well tested (lease expiry, dedupe, re-run). Polling keeps Neon compute awake: prefer the external tick on a schedule matched to need.

## Revisit when
The host is chosen (always-on container hosts may justify pg-boss) or job volume grows.
