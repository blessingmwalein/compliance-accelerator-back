import type { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { EnvironmentVariables } from '../config/env.schema.js';
import { RequestContext } from '../tenancy/request-context.js';
import type { JobContext, JobHandlerContract } from './job-handler.js';
import type { JobHandlerRegistry } from './job-handler.registry.js';
import { JobRunner } from './job-runner.service.js';
import type { ClaimedJob, JobsRepository } from './jobs.repository.js';

beforeAll(() => {
  Logger.overrideLogger(false);
});

const job = (overrides: Partial<ClaimedJob> = {}): ClaimedJob => ({
  id: 'job-1',
  type: 'test.job',
  payload: { userId: 'u1' },
  attempts: 1,
  maxAttempts: 3,
  ...overrides,
});

function setup(
  handlers: Record<string, JobHandlerContract>,
  claimed: ClaimedJob[],
  exhaustedLeases = 0,
) {
  const repository = {
    deadLetterExhaustedLeases: vi.fn(async () => exhaustedLeases),
    claim: vi.fn(async () => claimed),
    succeed: vi.fn(async (_id: string, _worker: string) => true),
    fail: vi.fn(
      async (_id: string, _worker: string, _error: string, _retryAt: Date | null) => true,
    ),
  };
  const registry = { get: (type: string) => handlers[type] } as unknown as JobHandlerRegistry;
  const config = {
    get: (key: string) => ({ JOBS_BATCH_SIZE: 7, JOBS_LEASE_SECONDS: 45 })[key],
  } as unknown as ConfigService<EnvironmentVariables, true>;
  const context = new RequestContext();
  const runner = new JobRunner(repository as unknown as JobsRepository, registry, context, config);
  return { runner, repository, context };
}

describe('JobRunner.runBatch', () => {
  it('claims a bounded batch with the configured limit and lease, and counts successes', async () => {
    const handler = { handle: vi.fn(async () => undefined) };
    const { runner, repository } = setup({ 'test.job': handler }, [
      job({ id: 'a' }),
      job({ id: 'b' }),
    ]);
    const summary = await runner.runBatch({ workerId: 'w1' });
    expect(summary).toEqual({ claimed: 2, succeeded: 2, retried: 0, dead: 0 });
    expect(repository.claim).toHaveBeenCalledWith(7, 45, 'w1');
    expect(repository.succeed).toHaveBeenCalledWith('a', 'w1');
    expect(repository.succeed).toHaveBeenCalledWith('b', 'w1');
  });

  it('passes the job context to the handler (attempt numbering starts at 1)', async () => {
    let seen: JobContext | undefined;
    const { runner } = setup({ 'test.job': { handle: async (_p, c) => void (seen = c) } }, [
      job({ attempts: 2 }),
    ]);
    await runner.runBatch();
    expect(seen).toEqual({ jobId: 'job-1', attempt: 2, maxAttempts: 3 });
  });

  it('a failing attempt goes back to the queue with backoff and a sanitised error', async () => {
    const before = Date.now();
    const handler = {
      handle: vi.fn(async () => Promise.reject(new Error('SMTP refused maria@example.com'))),
    };
    const { runner, repository } = setup({ 'test.job': handler }, [
      job({ attempts: 1, maxAttempts: 3 }),
    ]);
    const summary = await runner.runBatch({ workerId: 'w1' });

    expect(summary).toEqual({ claimed: 1, succeeded: 0, retried: 1, dead: 0 });
    const [id, worker, error, retryAt] = repository.fail.mock.calls[0]!;
    expect([id, worker]).toEqual(['job-1', 'w1']);
    expect(error).toContain('[email]');
    expect(error).not.toContain('maria');
    expect(retryAt).toBeInstanceOf(Date);
    expect(retryAt!.getTime()).toBeGreaterThan(before + 20_000); // first backoff is about 30 s
    expect(repository.succeed).not.toHaveBeenCalled();
  });

  it('dead-letters a job that fails on its last allowed attempt', async () => {
    const handler = { handle: vi.fn(async () => Promise.reject(new Error('still broken'))) };
    const { runner, repository } = setup({ 'test.job': handler }, [
      job({ attempts: 3, maxAttempts: 3 }),
    ]);
    const summary = await runner.runBatch({ workerId: 'w1' });
    expect(summary).toEqual({ claimed: 1, succeeded: 0, retried: 0, dead: 1 });
    expect(repository.fail.mock.calls[0]![3]).toBeNull();
  });

  it('dead-letters a job whose type has no handler instead of retrying forever', async () => {
    const { runner, repository } = setup({}, [job({ type: 'unknown.type' })]);
    const summary = await runner.runBatch({ workerId: 'w1' });
    expect(summary.dead).toBe(1);
    expect(repository.fail.mock.calls[0]![2]).toContain('no handler');
    expect(repository.fail.mock.calls[0]![3]).toBeNull();
  });

  it('one failing job never stops the rest of the batch', async () => {
    const handler = {
      handle: vi.fn(async (payload: unknown) => {
        if ((payload as { fail?: boolean }).fail) throw new Error('boom');
      }),
    };
    const { runner } = setup({ 'test.job': handler }, [
      job({ id: 'a', payload: { fail: true } }),
      job({ id: 'b', payload: {} }),
      job({ id: 'c', payload: {} }),
    ]);
    expect(await runner.runBatch()).toEqual({ claimed: 3, succeeded: 2, retried: 1, dead: 0 });
    expect(handler.handle).toHaveBeenCalledTimes(3);
  });

  it('adds the jobs dead-lettered for exhausted leases to the dead count', async () => {
    const { runner } = setup({}, [], 2);
    expect(await runner.runBatch()).toEqual({ claimed: 0, succeeded: 0, retried: 0, dead: 2 });
  });

  it('does not count a success when the lease was lost to another worker', async () => {
    const { runner, repository } = setup({ 'test.job': { handle: async () => undefined } }, [
      job(),
    ]);
    repository.succeed.mockResolvedValueOnce(false);
    expect((await runner.runBatch()).succeeded).toBe(0);
  });

  it('runs tenant jobs inside that tenant scope, as the system (no actor), tagged with the job id', async () => {
    let seen: { organisationId?: string; actorUserId?: string; requestId?: string } = {};
    const { runner, context } = setup(
      {
        'test.job': {
          handle: async () => {
            seen = {
              organisationId: context.organisationId,
              actorUserId: context.actorUserId,
              requestId: context.requestId,
            };
          },
        },
      },
      [job({ id: 'j9', payload: { organisationId: 'org-a', dsarId: 'd1' } })],
    );
    await runner.runBatch();
    expect(seen).toEqual({ organisationId: 'org-a', actorUserId: undefined, requestId: 'job:j9' });
  });

  it('runs jobs without an organisation outside any tenant scope', async () => {
    let organisation: string | undefined = 'unset';
    const { runner, context } = setup(
      { 'test.job': { handle: async () => void (organisation = context.organisationId) } },
      [job({ payload: { userId: 'u1' } })],
    );
    await runner.runBatch();
    expect(organisation).toBeUndefined();
  });
});
