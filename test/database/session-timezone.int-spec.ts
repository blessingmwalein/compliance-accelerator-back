import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createIntContext, type IntContext } from '../support/int-context.js';

/**
 * Prisma's pg adapter writes DateTime values as timestamps without an offset, so every instant is
 * only correct if the database session runs in UTC. A non-UTC session would not fail loudly: it
 * would shift every stored time by the offset (jobs due at the wrong moment, tokens that expire
 * early or late). Neon's default is UTC; `prisma/sql/runtime-role.sql` pins it for the runtime role.
 */
describe('database session time zone', () => {
  let ctx: IntContext;

  beforeAll(async () => {
    ctx = await createIntContext();
  });
  afterAll(async () => {
    await ctx.close();
  });

  it('the runtime connection runs in UTC', async () => {
    const rows = await ctx.prisma.db.$queryRaw<
      { tz: string }[]
    >`SELECT current_setting('TimeZone') AS tz`;
    expect(['UTC', 'Etc/UTC', 'GMT', 'Etc/GMT']).toContain(rows[0]?.tz);
  });

  it('an instant written by the application is the same instant to SQL now()', async () => {
    const future = new Date(Date.now() + 60 * 60 * 1000);
    const key = `tz-check:${future.getTime()}`;
    await ctx.admin.job.create({
      data: { type: 'tz.check', payload: {}, dedupeKey: key, runAt: future, status: 'DEAD' },
    });
    const rows = await ctx.admin.$queryRaw<{ ahead_seconds: number }[]>`
      SELECT extract(epoch FROM (run_at - now()))::float8 AS ahead_seconds FROM jobs WHERE dedupe_key = ${key}`;
    const ahead = rows[0]!.ahead_seconds;
    // about one hour ahead; a +/-2 h session offset would make this 3 h or -1 h
    expect(ahead).toBeGreaterThan(3500);
    expect(ahead).toBeLessThan(3700);
  });
});
