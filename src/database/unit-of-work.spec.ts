import type { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import type { EnvironmentVariables } from '../config/env.schema.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { RequestContext } from '../tenancy/request-context.js';
import { UnitOfWork } from './unit-of-work.js';

/** Plumbing test only: transactions, constraints and RLS are proven in the integration suite. */
function setup() {
  const queries: unknown[][] = [];
  const tx = { $queryRaw: vi.fn(async (...args: unknown[]) => void queries.push(args)) };
  const transaction = vi.fn(
    async (callback: (t: typeof tx) => Promise<unknown>, options: unknown) => {
      void options;
      return callback(tx);
    },
  );
  const prisma = { db: { $transaction: transaction } } as unknown as PrismaService;
  const config = {
    get: (key: string) =>
      ({
        DATABASE_CONNECT_TIMEOUT_MS: 10_000,
        DATABASE_TRANSACTION_TIMEOUT_MS: 10_000,
      })[key],
  } as unknown as ConfigService<EnvironmentVariables, true>;
  const context = new RequestContext();
  return { uow: new UnitOfWork(prisma, context, config), context, tx, transaction, queries };
}

describe('UnitOfWork.run', () => {
  it('passes the transaction client to the callback and returns its result', async () => {
    const { uow, tx } = setup();
    await expect(uow.run(async (t) => (t === (tx as never) ? 'same-tx' : 'other'))).resolves.toBe(
      'same-tx',
    );
  });

  it('sets app.org_id inside the transaction, as its first statement, for a verified tenant', async () => {
    const { uow, context, tx, queries } = setup();
    await context.run({ organisationId: 'org-a' }, () => uow.run(async () => undefined));
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    const [strings, value] = queries[0] as [TemplateStringsArray, string];
    expect(strings.join('?')).toContain("set_config('app.org_id', ?, true)");
    expect(value).toBe('org-a');
  });

  it('sets nothing for work outside a tenant (global tables)', async () => {
    const { uow, tx } = setup();
    await uow.run(async () => undefined);
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });

  it('uses short, explicit transaction limits that callers can override', async () => {
    const { uow, transaction } = setup();
    await uow.run(async () => undefined);
    await uow.run(async () => undefined, { timeoutMs: 2_000, maxWaitMs: 500 });
    expect(transaction.mock.calls[0]![1]).toEqual({ maxWait: 10_000, timeout: 10_000 });
    expect(transaction.mock.calls[1]![1]).toEqual({ maxWait: 500, timeout: 2_000 });
  });

  it('propagates errors so the transaction rolls back', async () => {
    const { uow } = setup();
    await expect(uow.run(async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
  });
});
