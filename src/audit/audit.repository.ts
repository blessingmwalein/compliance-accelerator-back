import { Injectable } from '@nestjs/common';
import { TenantRepository } from '../database/tenant-repository.js';
import type { Tx } from '../database/db-client.js';
import type { Prisma } from '../generated/prisma/client.js';
import { RequestContext } from '../tenancy/request-context.js';

export interface NewAuditEvent {
  actorType: 'USER' | 'SYSTEM';
  actorUserId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  entityLabel: string | null;
  outcome: 'SUCCESS' | 'DENIED' | 'FAILURE';
  requestId: string | null;
  /** Already redacted JSON, or null. */
  changes: unknown;
}

/** Insert-only: there is deliberately no update or delete (the database also forbids both). */
@Injectable()
export class AuditRepository extends TenantRepository {
  constructor(requestContext: RequestContext) {
    super(requestContext);
  }

  /** Runs on the caller's transaction so the event commits or rolls back with the change it records. */
  async insert(tx: Tx, event: NewAuditEvent): Promise<void> {
    await tx.auditEvent.create({
      data: {
        organisationId: this.organisationId,
        actorType: event.actorType,
        actorUserId: event.actorUserId,
        action: event.action,
        entityType: event.entityType,
        entityId: event.entityId,
        entityLabel: event.entityLabel,
        outcome: event.outcome,
        requestId: event.requestId,
        changes: (event.changes ?? undefined) as Prisma.InputJsonValue | undefined,
      },
      select: { id: true },
    });
  }
}
