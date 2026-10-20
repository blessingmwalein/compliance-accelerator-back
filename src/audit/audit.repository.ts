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

/** One stored event read back. `occurredAt` is the database's own instant, never a client value. */
export interface AuditEventRecord {
  id: string;
  occurredAt: Date;
  actorType: 'USER' | 'SYSTEM';
  actorUserId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  entityLabel: string | null;
  outcome: 'SUCCESS' | 'DENIED' | 'FAILURE';
  requestId: string | null;
  changes: unknown;
}

export interface AuditListOptions {
  limit: number;
  /** The id of the last event of the previous page (events are keyed by UUIDv7, so id order is time order). */
  after?: string;
  /** Calendar days, applied as whole UTC days. */
  from?: string;
  to?: string;
  actorUserId?: string;
  action?: string;
  entityType?: string;
  entityId?: string;
  outcome?: 'SUCCESS' | 'DENIED' | 'FAILURE';
}

const SELECT = {
  id: true,
  occurredAt: true,
  actorType: true,
  actorUserId: true,
  action: true,
  entityType: true,
  entityId: true,
  entityLabel: true,
  outcome: true,
  requestId: true,
  changes: true,
} as const;

const DAY_MS = 24 * 60 * 60 * 1000;
const dayStart = (date: string): Date => new Date(`${date}T00:00:00.000Z`);
/** The instant just after this day, so `to` includes the whole day rather than its first second. */
const dayAfter = (date: string): Date => new Date(dayStart(date).getTime() + DAY_MS);

/**
 * The append-only writer, and now also the only reader. There is deliberately no update or delete —
 * the database forbids both by trigger and by grant — so a read is the whole of the second half.
 */
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

  /**
   * Newest event first: a trail is read to answer "what happened here, recently", and an incident review
   * starts at the top. Every filter is one of the four the criterion names — period, actor, action, record —
   * and each maps onto an index the table already carries (`[organisationId, occurredAt]`,
   * `[organisationId, action, occurredAt]`, `[organisationId, actorUserId, occurredAt]`).
   */
  async list(tx: Tx, options: AuditListOptions): Promise<AuditEventRecord[]> {
    const occurredAt: Prisma.DateTimeFilter = {};
    if (options.from) occurredAt.gte = dayStart(options.from);
    if (options.to) occurredAt.lt = dayAfter(options.to);

    const rows = await tx.auditEvent.findMany({
      where: {
        organisationId: this.organisationId,
        ...(Object.keys(occurredAt).length > 0 ? { occurredAt } : {}),
        ...(options.actorUserId ? { actorUserId: options.actorUserId } : {}),
        ...(options.action ? { action: options.action } : {}),
        ...(options.entityType ? { entityType: options.entityType } : {}),
        ...(options.entityId ? { entityId: options.entityId } : {}),
        ...(options.outcome ? { outcome: options.outcome } : {}),
        ...(options.after ? { id: { lt: options.after } } : {}),
      },
      orderBy: { id: 'desc' },
      take: options.limit + 1,
      select: SELECT,
    });
    return rows;
  }
}
