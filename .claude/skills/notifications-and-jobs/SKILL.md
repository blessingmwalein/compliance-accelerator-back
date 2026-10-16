---
name: notifications-and-jobs
description: Use when sending email or in-app notifications, scheduling reminders/SLA checks, running background jobs (reports, recalculations), working with the outbox/lease runner, the job tick endpoint, delivery tracking or notification preferences in fca-backend.
---

# Notifications and jobs (backend, normative)

## When to use
Anything that happens "later", "periodically" or "to someone else": invitation/verification/reset emails, deadline reminders, overdue DSAR/breach alerts, report generation, band recalculation, certificate issue. Hosting is undecided (gate G0), so nothing may assume an always-on process.

## Rules

### Jobs: transactional outbox + lease runner (ADR-0006; **built** in Phase 2b in `src/jobs`; `scheduled_jobs` is deferred until the first recurring job)
- **Tenant jobs** (first one: `invitations.send`, Phase 2c) carry `{ organisationId, … ids }` in the payload; the runner opens the tenant scope from `organisationId`, so the handler uses `uow.run` and tenant repositories like a request would. The handler re-reads the record (revoked or accepted ends the job), creates the one-time token at send time, commits its hash, and only then sends. Dedupe key `<type>:<id>:<5-minute window>` makes "create then resend" one email.
1. Work is recorded as a row in `jobs` **inside the same transaction** as the domain change that causes it, so a notification can never be lost or sent for a rolled-back change.
2. `jobs`: `id`, `type`, `payload` (JSONB, **no personal data beyond ids**), `run_at`, `status` (`queued|leased|succeeded|failed|dead`), `attempts`, `max_attempts`, `lease_until`, `leased_by`, `dedupe_key` (**unique**), `last_error` (sanitised), timestamps. `scheduled_jobs` holds recurring definitions (cron-like) that enqueue concrete jobs.
3. A runner claims work with `SELECT … FOR UPDATE SKIP LOCKED` (`run_at <= now() AND status='queued'`, or expired leases), processes within the lease, retries with exponential backoff + jitter, and dead-letters after `max_attempts`. Safe with several instances.
4. **Two ways to drive it, same code**: (a) an in-process poller (`worker.ts` / Nest module, for always-on hosts and local dev), (b) `POST /api/v1/internal/jobs/tick` called by host cron / an external scheduler every 1–5 minutes. The endpoint is `@Public()` but requires an **HMAC-signed** request (`JOBS_TICK_SECRET`, timestamp window), processes a **bounded batch**, and returns counts only. This keeps the design valid on serverless hosts.
5. **Idempotency**: every enqueue supplies a deterministic `dedupe_key` (`dsar-overdue:{dsarId}:{dueDate}`, `task-due:{taskId}:{dueOn}:{threshold}`); handlers re-check state (`sent_at`, current status) before acting, because jobs run at-least-once.
6. Handlers are small, named, registered in a map (`JobHandler<TPayload>`); a `JobQueue` interface keeps the option to swap in pg-boss/BullMQ later. **pg-boss and BullMQ/Redis are rejected for now** (always-on worker, schema ownership, polling that blocks Neon scale-to-zero, extra infrastructure).
7. Neon pooler rules apply (`database-and-tenancy`): the runner uses short transactions and `pg_advisory_xact_lock`; never session locks or `LISTEN/NOTIFY`.

### Email (**built** in Phase 2b in `src/mail`: `EmailProvider`, `FileMailTransport`, templates, `email_deliveries`; SMTP/ESP waits for gate G0)
- **One-time links are made by the email JOB at send time** (`AuthLinkService.issue`): the raw token exists only in memory and in the message; the database stores its SHA-256 and the job payload only the user id. A retried job creates a new token and deletes unused ones. Put the token in the URL **fragment** (`/verify-email#token=…`). `email_deliveries` has no organisation column yet: add a tenant-scoped delivery table when the first organisation-level email (DPO alert) is built.
- `EmailProvider` interface: `send({ to, subject, html, text, metadata })`. Drivers: **file transport** (dev/test: writes `.eml` files to `.dev-mail/` and logs the action link, no Docker/Mailpit needed) and **SMTP/ESP** (production; provider chosen at G0 with SPF/DKIM/DMARC lead time).
- `email_deliveries`: `id`, `organisation_id` (nullable for pre-membership mail), `to_address`, `template`, `status` (`queued|sent|delivered|bounced|complained|failed|suppressed`), `provider_message_id`, `attempts`, `last_error`, timestamps. Keyed on the **address**, not a user: invitees and the DPO contact need not be registered users (the legacy `SendEmail` reached only registered users and silently dropped the rest). Provider webhooks (signed) update status; suppress addresses that hard-bounce.
- **Link-only bodies**: emails state that something needs attention and link into the app; they never contain DSAR subject details, breach specifics, or other personal data. Templates are versioned, plain-text + HTML, with the organisation name and a footer with the product disclaimer.
- Recipients: the **designated DPO contact** for breach/DSAR alerts (fallback: organisation owner(s)); the assignee for task reminders; notification preferences per user may reduce but not remove mandatory security mail.
- Never gate delivery by subscription plan text in the email body (the legacy reminder said "sent to Starter and Growth plan users"); entitlement checks happen in code.

### Scheduling rules
- Thresholds and windows come from configuration/policy rows (`deadline_policies`, reminder settings), not constants. Defaults: task due-soon window 7 days; RoPA due-soon 30 days before review date; DSAR/breach windows **Not configured** until a verified policy exists (`grc-domain`).
- Compare **calendar days in the organisation timezone** (`forms-and-validation`): due tomorrow ≠ due today.
- Each notification type has `reminder_sent_at`-style state **per threshold** (e.g. 7 days, 1 day, overdue) so a re-run never re-sends; the legacy `reminder_sent` flag was written but never read, so every click re-sent.
- Bulk operations (reminders, recalculation) process in **batches** with per-item error capture; one failure never aborts the batch (the legacy loop had no try/catch).

### In-app notifications
`notifications` table (tenant + user scoped): `type`, `title`, `link`, `read_at`; created by the same jobs/events that send email. Endpoints: list (cursor), unread count, mark read/all read. Real-time push is out of scope; the frontend polls/refetches.

### Observability
Every job logs `jobId`, `type`, `attempt`, `durationMs`, outcome (no payload contents). Dead-lettered jobs raise an operator-visible alert (log level `error`) and appear on a platform diagnostics endpoint.

## Example

```ts
// enqueue inside the same transaction as the change (service)
await this.jobs.enqueue(tx, {
  type: 'email.dsar-overdue',
  runAt: dueAt,                                   // timestamptz computed from the org timezone + policy
  dedupeKey: `dsar-overdue:${dsar.id}:${dsar.dueOn}`,
  payload: { organisationId, dsarId: dsar.id },   // ids only
});

// handler: idempotent and state-checked
@JobHandler('email.dsar-overdue')
async handle({ organisationId, dsarId }: DsarOverduePayload) {
  const dsar = await this.repo.findInOrganisation(organisationId, dsarId);
  if (!dsar || dsar.status === 'Completed' || dsar.overdueNotifiedAt) return;           // at-least-once safe
  await this.mailer.send(organisationId, 'dsar-overdue', this.recipients.dpoContact(organisationId), { link });
  await this.repo.markOverdueNotified(organisationId, dsarId);
}
```

## Anti-patterns
- Sending email inline in the request path or inside a loop without error handling; losing alerts when the process restarts; `setTimeout`/in-process cron as the only scheduler.
- Personal data in job payloads, logs or email bodies; recipients limited to registered users; plan names in message text.
- `reminder_sent: true` booleans that are never read; non-deterministic dedupe keys; handlers that assume exactly-once.
- Day arithmetic that truncates; hard-coded "7 days"/"72 hours" in code.
- Session advisory locks, `LISTEN/NOTIFY` or long transactions behind the Neon pooler.

## Checklist
- [ ] Job enqueued in the same transaction as the change; deterministic `dedupe_key`; payload = ids only
- [ ] Handler idempotent and re-checks state; retries/backoff/dead-letter configured
- [ ] Works from both the in-process runner and the HMAC-signed tick endpoint
- [ ] Email through `EmailProvider`; delivery row keyed on address; link-only body; recipients per rules
- [ ] Windows/thresholds read from policy; calendar-day maths in the organisation timezone; per-threshold sent state
- [ ] Batch work isolates per-item failures; logs have job id/type/outcome without payload data
- [ ] Tests: dedupe, retry, lease expiry, idempotent re-run, timezone boundary

## References
ADR-0006, `backend-architecture` (transactions), `database-and-tenancy` (Neon pooler), `grc-domain` (deadline policies), frontend `notifications-and-jobs`.
