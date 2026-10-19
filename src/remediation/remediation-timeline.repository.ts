import { Injectable } from '@nestjs/common';
import type { Tx } from '../database/db-client.js';
import { TenantRepository } from '../database/tenant-repository.js';
import type { TaskStatus } from '../domain/remediation/policy.js';
import type { TaskEventKind } from '../generated/prisma/enums.js';
import { RequestContext } from '../tenancy/request-context.js';

/** One timeline entry, as the API shows it. */
export interface EventRecord {
  id: string;
  kind: TaskEventKind;
  fromStatus: TaskStatus | null;
  toStatus: TaskStatus | null;
  body: string | null;
  actorUserId: string;
  actorName: string;
  createdAt: Date;
}

/** What a caller appends: a comment, one status change, or a reassignment. */
export interface NewEvent {
  kind: TaskEventKind;
  fromStatus?: TaskStatus | null;
  toStatus?: TaskStatus | null;
  /** The comment text, the reason of a reopen, or the line a reassignment writes. */
  body?: string | null;
  /** From the request context, never from the caller: an event is always attributed. */
  actorUserId: string;
}

const SELECT = {
  id: true,
  kind: true,
  fromStatus: true,
  toStatus: true,
  body: true,
  actorUserId: true,
  createdAt: true,
  actor: { select: { fullName: true } },
} as const;

type EventRow = Omit<EventRecord, 'actorName'> & { actor: { fullName: string } };

const toEventRecord = ({ actor, ...row }: EventRow): EventRecord => ({
  ...row,
  actorName: actor.fullName,
});

/**
 * The timeline of a remediation task, and the evidence ids linked to it.
 *
 * `remediation_task_events` is APPEND-ONLY: the database rejects UPDATE and DELETE on it (the trigger in
 * the `assessment_scoring_remediation` migration), so this repository deliberately has no update or
 * delete method. The same is true of the audit trail. Events are written inside the caller's transaction,
 * so a status change and its timeline entry commit or roll back together.
 */
@Injectable()
export class RemediationTimelineRepository extends TenantRepository {
  constructor(requestContext: RequestContext) {
    super(requestContext);
  }

  /** Oldest first: the same order the timeline reads in, with the actor's name so no extra call is needed. */
  async listForTask(tx: Tx, taskId: string): Promise<EventRecord[]> {
    const rows = await tx.remediationTaskEvent.findMany({
      where: { organisationId: this.organisationId, taskId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: SELECT,
    });
    return rows.map(toEventRecord);
  }

  /** Inserts ONE event. Never called twice for one change, and never called for an update. */
  append(tx: Tx, taskId: string, event: NewEvent): Promise<{ id: string }> {
    return tx.remediationTaskEvent.create({
      data: {
        organisationId: this.organisationId,
        taskId,
        kind: event.kind,
        fromStatus: event.fromStatus ?? null,
        toStatus: event.toStatus ?? null,
        body: event.body ?? null,
        actorUserId: event.actorUserId,
      },
      select: { id: true },
    });
  }

  /** The evidence files linked to this task (ids only; the files belong to the evidence module). */
  async evidenceIdsForTask(tx: Tx, taskId: string): Promise<string[]> {
    const rows = await tx.remediationTaskEvidence.findMany({
      where: { organisationId: this.organisationId, taskId },
      orderBy: { linkedAt: 'asc' },
      select: { evidenceId: true },
    });
    return rows.map((row) => row.evidenceId);
  }
}
