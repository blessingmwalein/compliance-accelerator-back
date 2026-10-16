import { Injectable } from '@nestjs/common';
import type { Tx } from '../database/db-client.js';
import { TenantRepository } from '../database/tenant-repository.js';
import { RequestContext } from '../tenancy/request-context.js';

export interface EntitlementRecord {
  planId: string;
  planCode: string;
  planName: string;
  maxUsers: number | null;
  apiAccess: boolean;
  assignedAt: Date;
}

export interface EntitlementSnapshot {
  planId: string;
  planCode: string;
  planName: string;
  maxUsers: number | null;
  apiAccess: boolean;
  assignedByUserId: string;
}

const SELECT = {
  planId: true,
  planCode: true,
  planName: true,
  maxUsers: true,
  apiAccess: true,
  assignedAt: true,
} as const;

/**
 * What the CURRENT organisation is entitled to: a snapshot copied from its plan when the plan was
 * assigned, so a later change to (or hiding of) the plan never changes it. No row = no plan assigned.
 */
@Injectable()
export class EntitlementsRepository extends TenantRepository {
  constructor(requestContext: RequestContext) {
    super(requestContext);
  }

  get(tx: Tx): Promise<EntitlementRecord | null> {
    return tx.organisationEntitlement.findFirst({
      where: { organisationId: this.organisationId },
      select: SELECT,
    });
  }

  async upsert(tx: Tx, snapshot: EntitlementSnapshot): Promise<void> {
    await tx.organisationEntitlement.upsert({
      where: { organisationId: this.organisationId },
      create: { ...snapshot, organisationId: this.organisationId },
      update: { ...snapshot, assignedAt: new Date(), version: { increment: 1 } },
      select: { id: true },
    });
  }

  countActiveMembers(tx: Tx): Promise<number> {
    return tx.membership.count({
      where: { organisationId: this.organisationId, status: 'ACTIVE' },
    });
  }

  /** Invitations still open (pending and not expired): they hold a seat like a member does. */
  countOpenInvitations(tx: Tx, now: Date): Promise<number> {
    return tx.invitation.count({
      where: { organisationId: this.organisationId, status: 'PENDING', expiresAt: { gt: now } },
    });
  }
}
