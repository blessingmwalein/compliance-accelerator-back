import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createIntContext, seedTwoOrganisations, type IntContext } from '../support/int-context.js';

describe('audit trail on a real database (AC-AUD-01, AC-AUD-02)', () => {
  let ctx: IntContext;
  let seed: Awaited<ReturnType<typeof seedTwoOrganisations>>;

  beforeAll(async () => {
    ctx = await createIntContext();
    seed = await seedTwoOrganisations(ctx.admin);
  });
  afterAll(async () => {
    await ctx.close();
  });

  const orgId = () => seed.a.organisation.id;
  const asA = <T>(fn: () => Promise<T>, actorUserId: string | undefined = seed.a.user.id) =>
    ctx.requestContext.run(
      { organisationId: orgId(), actorUserId, requestIdOf: () => 'req-int-1' },
      fn,
    );

  const newKey = (key: string) => ({
    organisationId: orgId(),
    key,
    endpoint: 'POST /int',
    requestHash: 'h',
    expiresAt: new Date(Date.now() + 60_000),
  });

  it('writes an event with the database clock, the actor and the request id', async () => {
    const before = new Date();
    await asA(() =>
      ctx.uow.run((tx) =>
        ctx.audit.record(tx, {
          action: 'membership.role_changed',
          entityType: 'membership',
          entityId: seed.a.membership.id,
          entityLabel: 'User A',
          changes: {
            role: { from: 'COMPANY_OWNER', to: 'READ_ONLY' },
            inviteToken: 'must-not-be-stored',
          },
        }),
      ),
    );
    const event = await ctx.admin.auditEvent.findFirstOrThrow({
      where: { organisationId: orgId(), entityId: seed.a.membership.id },
    });
    expect(event).toMatchObject({
      actorType: 'USER',
      actorUserId: seed.a.user.id,
      action: 'membership.role_changed',
      outcome: 'SUCCESS',
      requestId: 'req-int-1',
    });
    expect(event.occurredAt.getTime()).toBeGreaterThanOrEqual(before.getTime() - 5_000);
    expect(event.changes).toEqual({
      role: { from: 'COMPANY_OWNER', to: 'READ_ONLY' },
      inviteToken: '[REDACTED]',
    });
  });

  it('commits the change and its audit event together', async () => {
    await asA(() =>
      ctx.uow.run(async (tx) => {
        await tx.idempotencyKey.create({ data: newKey('commit-together') });
        await ctx.audit.record(tx, {
          action: 'organisation.created',
          entityType: 'organisation',
          entityId: orgId(),
        });
      }),
    );
    expect(
      await ctx.admin.idempotencyKey.count({
        where: { organisationId: orgId(), key: 'commit-together' },
      }),
    ).toBe(1);
  });

  it('FAILS CLOSED: if the audit insert fails, the change is rolled back', async () => {
    // an actor that does not exist violates the foreign key, so the audit insert fails
    const ghost = randomUUID();
    await expect(
      asA(
        () =>
          ctx.uow.run(async (tx) => {
            await tx.idempotencyKey.create({ data: newKey('rolled-back-by-audit') });
            await ctx.audit.record(tx, {
              action: 'organisation.created',
              entityType: 'organisation',
            });
          }),
        ghost,
      ),
    ).rejects.toThrow();
    expect(
      await ctx.admin.idempotencyKey.count({
        where: { organisationId: orgId(), key: 'rolled-back-by-audit' },
      }),
    ).toBe(0);
  });

  it('rolls the audit event back when the change itself fails', async () => {
    await expect(
      asA(() =>
        ctx.uow.run(async (tx) => {
          await ctx.audit.record(tx, {
            action: 'organisation.created',
            entityType: 'organisation',
            entityId: 'rolled-back-by-change',
          });
          throw new Error('business rule failed');
        }),
      ),
    ).rejects.toThrow('business rule failed');
    expect(
      await ctx.admin.auditEvent.count({
        where: { organisationId: orgId(), entityId: 'rolled-back-by-change' },
      }),
    ).toBe(0);
  });

  it('rejects UPDATE through the application (append-only trigger)', async () => {
    await expect(
      asA(() =>
        ctx.prisma.db.auditEvent.updateMany({
          where: { organisationId: orgId() },
          data: { action: 'tampered' },
        }),
      ),
    ).rejects.toThrow(/append-only/);
  });

  it('rejects DELETE through the application (append-only trigger)', async () => {
    await expect(
      asA(() => ctx.prisma.db.auditEvent.deleteMany({ where: { organisationId: orgId() } })),
    ).rejects.toThrow(/append-only/);
  });

  it('rejects UPDATE and DELETE even for the owner role', async () => {
    await expect(
      ctx.admin.auditEvent.updateMany({
        where: { organisationId: orgId() },
        data: { action: 'tampered' },
      }),
    ).rejects.toThrow(/append-only/);
    await expect(
      ctx.admin.auditEvent.deleteMany({ where: { organisationId: orgId() } }),
    ).rejects.toThrow(/append-only/);
  });

  it('keeps events of one organisation out of another organisation reads', async () => {
    const asB = <T>(fn: () => Promise<T>) =>
      ctx.requestContext.run({ organisationId: seed.b.organisation.id }, fn);
    const rows = await asB(() =>
      ctx.prisma.db.auditEvent.findMany({ where: { organisationId: seed.b.organisation.id } }),
    );
    expect(rows).toEqual([]);
  });
});
