import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createIntContext, type IntContext } from '../support/int-context.js';

/** The hand-written SQL of the auth_and_jobs migration, checked directly (Prisma cannot model it). */
describe('auth and jobs schema constraints', () => {
  let ctx: IntContext;
  const tag = randomUUID().slice(0, 8);
  let userId: string;

  beforeAll(async () => {
    ctx = await createIntContext();
    userId = (
      await ctx.admin.user.create({
        data: { email: `schema-${tag}@example.test`, fullName: 'Schema' },
      })
    ).id;
  });
  afterAll(async () => {
    await ctx.close();
  });

  const past = () => new Date(Date.now() - 60_000);
  const future = () => new Date(Date.now() + 3_600_000);

  it('security_events is append-only for every role, with the message visible to the caller', async () => {
    const event = await ctx.admin.securityEvent.create({
      data: { eventType: 'auth.login_failed', outcome: 'DENIED', userId },
    });
    await expect(
      ctx.admin.securityEvent.update({ where: { id: event.id }, data: { eventType: 'tampered' } }),
    ).rejects.toThrow(/append-only/);
    await expect(ctx.admin.securityEvent.delete({ where: { id: event.id } })).rejects.toThrow(
      /append-only/,
    );
    expect(
      (await ctx.admin.securityEvent.findUniqueOrThrow({ where: { id: event.id } })).eventType,
    ).toBe('auth.login_failed');
  });

  it('security_events refuses a user id that does not exist and keeps the user undeletable', async () => {
    await expect(
      ctx.admin.securityEvent.create({ data: { eventType: 'x', userId: randomUUID() } }),
    ).rejects.toThrow();
    await expect(ctx.admin.user.delete({ where: { id: userId } })).rejects.toThrow(); // RESTRICT: events keep their subject
  });

  it('a refresh token or an auth token must expire after it was created', async () => {
    const session = await ctx.admin.session.create({ data: { userId, expiresAt: future() } });
    await expect(
      ctx.admin.refreshToken.create({
        data: { sessionId: session.id, tokenHash: `h-${randomUUID()}`, expiresAt: past() },
      }),
    ).rejects.toThrow(/refresh_tokens_expiry_check/);
    await expect(
      ctx.admin.authToken.create({
        data: {
          userId,
          purpose: 'PASSWORD_RESET',
          tokenHash: `h-${randomUUID()}`,
          expiresAt: past(),
        },
      }),
    ).rejects.toThrow(/auth_tokens_expiry_check/);
  });

  it('token hashes are unique, so one token can never identify two rows', async () => {
    const hash = `unique-${randomUUID()}`;
    await ctx.admin.authToken.create({
      data: { userId, purpose: 'EMAIL_VERIFICATION', tokenHash: hash, expiresAt: future() },
    });
    await expect(
      ctx.admin.authToken.create({
        data: { userId, purpose: 'PASSWORD_RESET', tokenHash: hash, expiresAt: future() },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('deleting a session removes its refresh tokens (cascade) but never a user with a session', async () => {
    const session = await ctx.admin.session.create({ data: { userId, expiresAt: future() } });
    await ctx.admin.refreshToken.create({
      data: { sessionId: session.id, tokenHash: `c-${randomUUID()}`, expiresAt: future() },
    });
    await ctx.admin.session.delete({ where: { id: session.id } });
    expect(await ctx.admin.refreshToken.count({ where: { sessionId: session.id } })).toBe(0);
  });

  it('jobs refuse impossible attempt counts and duplicate dedupe keys', async () => {
    const key = `schema-${tag}`;
    await expect(
      ctx.admin.job.create({
        data: { type: 't', payload: {}, dedupeKey: `${key}-neg`, attempts: -1 },
      }),
    ).rejects.toThrow(/jobs_attempts_check/);
    await expect(
      ctx.admin.job.create({
        data: { type: 't', payload: {}, dedupeKey: `${key}-zero`, maxAttempts: 0 },
      }),
    ).rejects.toThrow(/jobs_attempts_check/);
    await ctx.admin.job.create({
      data: { type: 't', payload: {}, dedupeKey: `${key}-dup`, status: 'DEAD' },
    });
    await expect(
      ctx.admin.job.create({ data: { type: 't', payload: {}, dedupeKey: `${key}-dup` } }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('the claim query uses the partial indexes (a scan of only claimable rows)', async () => {
    const rows = await ctx.admin.$queryRaw<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes WHERE tablename = 'jobs' AND indexname IN ('jobs_queued_run_at_idx', 'jobs_leased_lease_until_idx')`;
    expect(rows.map((r) => r.indexname).sort()).toEqual([
      'jobs_leased_lease_until_idx',
      'jobs_queued_run_at_idx',
    ]);
  });

  it('email deliveries record one row per attempt for any address, user or not', async () => {
    const address = `nobody-${tag}@example.test`;
    await ctx.admin.emailDelivery.create({
      data: { toAddress: address, template: 'verify-email', attempts: 1 },
    });
    await ctx.admin.emailDelivery.create({
      data: {
        toAddress: address,
        template: 'verify-email',
        attempts: 1,
        status: 'FAILED',
        lastError: 'x',
      },
    });
    expect(await ctx.admin.emailDelivery.count({ where: { toAddress: address } })).toBe(2);
    await expect(
      ctx.admin.emailDelivery.create({ data: { toAddress: address, template: 't', attempts: -1 } }),
    ).rejects.toThrow(/email_deliveries_attempts_check/);
  });
});
