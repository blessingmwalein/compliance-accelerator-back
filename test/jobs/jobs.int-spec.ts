import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  JobHandler,
  type JobContext,
  type JobHandlerContract,
} from '../../src/jobs/job-handler.js';
import { JobsRepository } from '../../src/jobs/jobs.repository.js';
import { JobsService } from '../../src/jobs/jobs.service.js';
import { signTick } from '../../src/jobs/tick-signature.js';
import { createIntContext, type IntContext } from '../support/int-context.js';

/** Fails until `succeedOnAttempt`, then succeeds. Records every attempt it sees. */
@Injectable()
@JobHandler('test.flaky')
class FlakyHandler implements JobHandlerContract {
  static seen: Array<{ jobId: string; attempt: number }> = [];

  async handle(payload: unknown, context: JobContext): Promise<void> {
    FlakyHandler.seen.push({ jobId: context.jobId, attempt: context.attempt });
    const { succeedOnAttempt } = payload as { succeedOnAttempt: number };
    if (context.attempt < succeedOnAttempt)
      throw new Error('transient failure for someone@example.com');
  }
}

describe('jobs outbox on a real database (ADR-0006)', () => {
  let ctx: IntContext;
  let repository: JobsRepository;
  let jobs: JobsService;
  const tag = randomUUID().slice(0, 8);
  const key = (name: string) => `jobs-int:${tag}:${name}`;

  beforeAll(async () => {
    ctx = await createIntContext({ providers: [FlakyHandler] });
    repository = ctx.app.get(JobsRepository, { strict: false });
    jobs = ctx.app.get(JobsService, { strict: false });
  });
  afterAll(async () => {
    await ctx.close();
  });

  /** Makes the queued job due now. */
  const makeDue = (dedupeKey: string) =>
    ctx.admin.job.update({ where: { dedupeKey }, data: { runAt: new Date(Date.now() - 1000) } });
  const rowOf = (dedupeKey: string) => ctx.admin.job.findUniqueOrThrow({ where: { dedupeKey } });

  it('a second enqueue with the same dedupe key adds nothing', async () => {
    const k = key('dedupe');
    expect(
      await jobs.enqueue({
        type: 'test.flaky',
        payload: { succeedOnAttempt: 1 },
        dedupeKey: k,
        runAt: new Date(Date.now() + 3_600_000),
      }),
    ).toBe(true);
    expect(
      await jobs.enqueue({ type: 'test.flaky', payload: { succeedOnAttempt: 1 }, dedupeKey: k }),
    ).toBe(false);
    expect(await ctx.admin.job.count({ where: { dedupeKey: k } })).toBe(1);
  });

  it('is transactional: a job enqueued in a rolled-back transaction never exists', async () => {
    const k = key('rollback');
    await expect(
      ctx.uow.run(async (tx) => {
        await jobs.enqueue(
          { type: 'test.flaky', payload: { succeedOnAttempt: 1 }, dedupeKey: k },
          tx,
        );
        throw new Error('the business operation failed');
      }),
    ).rejects.toThrow('the business operation failed');
    expect(await ctx.admin.job.count({ where: { dedupeKey: k } })).toBe(0);

    await ctx.uow.run((tx) =>
      jobs.enqueue(
        {
          type: 'test.flaky',
          payload: { succeedOnAttempt: 1 },
          dedupeKey: k,
          runAt: new Date(Date.now() + 3_600_000),
        },
        tx,
      ),
    );
    expect(await ctx.admin.job.count({ where: { dedupeKey: k } })).toBe(1);
  });

  it('does not claim jobs that are not due yet', async () => {
    const k = key('future');
    await jobs.enqueue({
      type: 'test.flaky',
      payload: { succeedOnAttempt: 1 },
      dedupeKey: k,
      runAt: new Date(Date.now() + 3_600_000),
    });
    const claimed = await repository.claim(100, 60, 'w-future');
    expect(claimed.map((j) => j.id)).not.toContain((await rowOf(k)).id);
    expect((await rowOf(k)).status).toBe('QUEUED');
  });

  it('two workers claiming at once never take the same job (FOR UPDATE SKIP LOCKED)', async () => {
    const keys = Array.from({ length: 8 }, (_, i) => key(`parallel-${i}`));
    for (const k of keys)
      await jobs.enqueue({ type: 'test.flaky', payload: { succeedOnAttempt: 99 }, dedupeKey: k });
    for (const k of keys) await makeDue(k);
    const mine = new Set(
      (await ctx.admin.job.findMany({ where: { dedupeKey: { in: keys } } })).map((j) => j.id),
    );

    const [a, b] = await Promise.all([
      repository.claim(5, 60, 'worker-a'),
      repository.claim(5, 60, 'worker-b'),
    ]);
    const idsA = a.map((j) => j.id).filter((id) => mine.has(id));
    const idsB = b.map((j) => j.id).filter((id) => mine.has(id));
    expect(idsA.filter((id) => idsB.includes(id))).toEqual([]);
    expect(idsA.length + idsB.length).toBeLessThanOrEqual(8);
    expect(idsA.length + idsB.length).toBeGreaterThan(0);

    for (const claimedJob of [...a, ...b]) expect(claimedJob.attempts).toBe(1);
    // release them so other tests are not affected: dead-letter via the owner
    await ctx.admin.job.updateMany({
      where: { dedupeKey: { in: keys } },
      data: { status: 'DEAD' },
    });
  });

  it('retries with backoff, passes the attempt number, and finally succeeds', async () => {
    const k = key('flaky');
    FlakyHandler.seen = [];
    await jobs.enqueue({
      type: 'test.flaky',
      payload: { succeedOnAttempt: 3 },
      dedupeKey: k,
      maxAttempts: 5,
    });
    const id = (await rowOf(k)).id;

    await makeDue(k);
    await ctx.runner.runBatch({ limit: 100 });
    let row = await rowOf(k);
    expect(row).toMatchObject({ status: 'QUEUED', attempts: 1 });
    expect(row.runAt.getTime()).toBeGreaterThan(Date.now() + 15_000); // backed off by roughly 30 s
    expect(row.lastError).toContain('[email]');
    expect(row.lastError).not.toContain('someone@example.com');

    await makeDue(k);
    await ctx.runner.runBatch({ limit: 100 });
    expect(await rowOf(k)).toMatchObject({ status: 'QUEUED', attempts: 2 });

    await makeDue(k);
    await ctx.runner.runBatch({ limit: 100 });
    row = await rowOf(k);
    expect(row).toMatchObject({ status: 'SUCCEEDED', attempts: 3, lastError: null });
    expect(row.finishedAt).not.toBeNull();
    expect(FlakyHandler.seen.filter((s) => s.jobId === id).map((s) => s.attempt)).toEqual([
      1, 2, 3,
    ]);
  });

  it('dead-letters a job that keeps failing, keeping a sanitised error', async () => {
    const k = key('dead');
    await jobs.enqueue({
      type: 'test.flaky',
      payload: { succeedOnAttempt: 99 },
      dedupeKey: k,
      maxAttempts: 2,
    });
    await makeDue(k);
    await ctx.runner.runBatch({ limit: 100 });
    await makeDue(k);
    const summary = await ctx.runner.runBatch({ limit: 100 });
    expect(summary.dead).toBeGreaterThanOrEqual(1);
    const row = await rowOf(k);
    expect(row).toMatchObject({ status: 'DEAD', attempts: 2 });
    expect(row.lastError).toBeTruthy();
    // a dead job is never claimed again
    await ctx.runner.runBatch({ limit: 100 });
    expect((await rowOf(k)).attempts).toBe(2);
  });

  it('dead-letters a job with no registered handler instead of looping', async () => {
    const k = key('no-handler');
    await jobs.enqueue({ type: 'test.nobody-handles-this', payload: {}, dedupeKey: k });
    await makeDue(k);
    await ctx.runner.runBatch({ limit: 100 });
    expect(await rowOf(k)).toMatchObject({ status: 'DEAD' });
  });

  it('reclaims a job whose lease expired (a crashed worker); the old worker cannot finish it any more', async () => {
    const k = key('lease');
    await jobs.enqueue({ type: 'test.flaky', payload: { succeedOnAttempt: 1 }, dedupeKey: k });
    await makeDue(k);
    const first = (await repository.claim(100, 60, 'crashed-worker')).find((j) => j.id)!;
    const row = await rowOf(k);
    expect(row).toMatchObject({ status: 'LEASED', leasedBy: 'crashed-worker', attempts: 1 });
    expect(first).toBeDefined();

    // still leased: nobody else can take it
    expect((await repository.claim(100, 60, 'other')).map((j) => j.id)).not.toContain(row.id);

    // the lease runs out
    await ctx.admin.job.update({
      where: { dedupeKey: k },
      data: { leaseUntil: new Date(Date.now() - 1000) },
    });
    const reclaimed = await repository.claim(100, 60, 'healthy-worker');
    expect(reclaimed.map((j) => j.id)).toContain(row.id);
    expect(await rowOf(k)).toMatchObject({ leasedBy: 'healthy-worker', attempts: 2 });

    expect(await repository.succeed(row.id, 'crashed-worker')).toBe(false); // lost its lease
    expect(await repository.succeed(row.id, 'healthy-worker')).toBe(true);
    expect((await rowOf(k)).status).toBe('SUCCEEDED');
  });

  it('dead-letters a job whose lease expired on its last allowed attempt', async () => {
    const k = key('lease-exhausted');
    await jobs.enqueue({
      type: 'test.flaky',
      payload: { succeedOnAttempt: 1 },
      dedupeKey: k,
      maxAttempts: 1,
    });
    await makeDue(k);
    await repository.claim(100, 60, 'crasher');
    await ctx.admin.job.update({
      where: { dedupeKey: k },
      data: { leaseUntil: new Date(Date.now() - 1000) },
    });

    expect(await repository.deadLetterExhaustedLeases()).toBeGreaterThanOrEqual(1);
    expect(await rowOf(k)).toMatchObject({ status: 'DEAD', attempts: 1 });
    expect((await rowOf(k)).lastError).toContain('lease expired');
    expect((await repository.claim(100, 60, 'anyone')).map((j) => j.id)).not.toContain(
      (await rowOf(k)).id,
    );
  });

  it('the HMAC-signed tick endpoint runs one bounded batch and returns counts only', async () => {
    const k = key('tick');
    FlakyHandler.seen = [];
    await jobs.enqueue({ type: 'test.flaky', payload: { succeedOnAttempt: 1 }, dedupeKey: k });
    await makeDue(k);

    const ts = Math.floor(Date.now() / 1000);
    const response = await ctx
      .http()
      .post('/api/v1/internal/jobs/tick')
      .set('X-FCA-Timestamp', String(ts))
      .set('X-FCA-Signature', signTick(process.env.JOBS_TICK_SECRET!, ts))
      .expect(200);
    expect(Object.keys(response.body).sort()).toEqual(['claimed', 'dead', 'retried', 'succeeded']);
    expect(response.body.succeeded).toBeGreaterThanOrEqual(1);
    expect((await rowOf(k)).status).toBe('SUCCEEDED');

    await ctx.http().post('/api/v1/internal/jobs/tick').expect(401);
  });
});
