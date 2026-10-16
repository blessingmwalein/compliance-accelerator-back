import { describe, expect, it, vi } from 'vitest';
import type { Tx } from '../database/db-client.js';
import { RequestContext } from '../tenancy/request-context.js';
import type { AuditRepository, NewAuditEvent } from './audit.repository.js';
import { AuditService } from './audit.service.js';

const tx = {} as Tx;

function setup() {
  const context = new RequestContext();
  const inserted: Array<{ tx: Tx; event: NewAuditEvent }> = [];
  const repository = {
    insert: vi.fn(async (t: Tx, event: NewAuditEvent) => void inserted.push({ tx: t, event })),
  };
  const service = new AuditService(repository as unknown as AuditRepository, context);
  return { context, inserted, repository, service };
}

describe('AuditService.record', () => {
  it('writes on the caller transaction with actor and request id from the request scope', async () => {
    const { context, inserted, service } = setup();
    await context.run(
      { actorUserId: 'user-1', organisationId: 'org-a', requestIdOf: () => 'req-7' },
      () =>
        service.record(tx, {
          action: 'membership.role_changed',
          entityType: 'membership',
          entityId: 'm1',
          entityLabel: 'Ada',
        }),
    );
    expect(inserted).toHaveLength(1);
    expect(inserted[0]!.tx).toBe(tx);
    expect(inserted[0]!.event).toMatchObject({
      actorType: 'USER',
      actorUserId: 'user-1',
      action: 'membership.role_changed',
      entityType: 'membership',
      entityId: 'm1',
      entityLabel: 'Ada',
      outcome: 'SUCCESS',
      requestId: 'req-7',
      changes: null,
    });
  });

  it('records system work (no actor) as SYSTEM', async () => {
    const { context, inserted, service } = setup();
    await context.run({ organisationId: 'org-a' }, () =>
      service.record(tx, { action: 'organisation.created', entityType: 'organisation' }),
    );
    expect(inserted[0]!.event).toMatchObject({
      actorType: 'SYSTEM',
      actorUserId: null,
      requestId: null,
    });
  });

  it('redacts secrets from the changes before they reach the repository', async () => {
    const { context, inserted, service } = setup();
    await context.run({ organisationId: 'org-a' }, () =>
      service.record(tx, {
        action: 'membership.created',
        entityType: 'membership',
        changes: { role: { to: 'READ_ONLY' }, inviteToken: 'abc' },
      }),
    );
    expect(inserted[0]!.event.changes).toEqual({
      role: { to: 'READ_ONLY' },
      inviteToken: '[REDACTED]',
    });
  });

  it('FAILS CLOSED: a failing insert rejects, so the surrounding transaction rolls back', async () => {
    const { context, repository, service } = setup();
    repository.insert.mockRejectedValueOnce(new Error('connection reset'));
    await expect(
      context.run({ organisationId: 'org-a' }, () =>
        service.record(tx, { action: 'organisation.created', entityType: 'organisation' }),
      ),
    ).rejects.toThrow('connection reset');
  });
});
