import { Injectable } from '@nestjs/common';
import type { Tx } from '../database/db-client.js';
import { TenantRepository } from '../database/tenant-repository.js';
import type { DeadlinePolicyRow } from '../domain/incidents/policy.js';
import { RequestContext } from '../tenancy/request-context.js';

/** The stored row: the six windows, their ids, and the optimistic lock. */
export type DeadlinePolicyRecord = DeadlinePolicyRow & { version: number };

/** What a change may touch: any of the six windows, each either set or cleared. */
export type DeadlinePolicyChanges = Partial<Omit<DeadlinePolicyRow, 'id'>>;

const SELECT = {
  id: true,
  dsarResponseDays: true,
  dsarExtensionDays: true,
  dsarExtensionLimit: true,
  breachAssessmentDays: true,
  breachNotificationDays: true,
  alertLeadDays: true,
  version: true,
} as const;

/**
 * The deadline policy of the CURRENT organisation (AC-DSAR-03, AC-BRC-01): one row at most, and every
 * column nullable. Unlike the scoring policy there are no reference defaults behind the nulls — a window
 * that nobody chose does not exist, and the records that would have used it report `not_configured`.
 */
@Injectable()
export class DeadlinePolicyRepository extends TenantRepository {
  constructor(requestContext: RequestContext) {
    super(requestContext);
  }

  get(tx: Tx): Promise<DeadlinePolicyRecord | null> {
    return tx.deadlinePolicy.findUnique({
      where: { organisationId: this.organisationId },
      select: SELECT,
    });
  }

  create(tx: Tx, changes: DeadlinePolicyChanges): Promise<DeadlinePolicyRecord> {
    return tx.deadlinePolicy.create({
      data: { organisationId: this.organisationId, ...changes },
      select: SELECT,
    });
  }

  /** Optimistic locking: the update lands only while the row still carries the version that was read. */
  async update(
    tx: Tx,
    id: string,
    version: number,
    changes: DeadlinePolicyChanges,
  ): Promise<boolean> {
    const result = await tx.deadlinePolicy.updateMany({
      where: { id, version, organisationId: this.organisationId },
      data: { ...changes, version: { increment: 1 } },
    });
    return result.count === 1;
  }
}
