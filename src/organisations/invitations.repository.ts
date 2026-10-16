import { Injectable } from '@nestjs/common';
import type { Tx } from '../database/db-client.js';
import { TenantRepository } from '../database/tenant-repository.js';
import type { Role } from '../permissions/catalogue.js';
import { RequestContext } from '../tenancy/request-context.js';

export type InvitationStatusValue = 'PENDING' | 'ACCEPTED' | 'REVOKED';

export interface InvitationRecord {
  id: string;
  email: string;
  role: Role;
  status: InvitationStatusValue;
  expiresAt: Date;
  sendCount: number;
  version: number;
  createdAt: Date;
  invitedBy: { fullName: string };
}

const SELECT = {
  id: true,
  email: true,
  role: true,
  status: true,
  expiresAt: true,
  sendCount: true,
  version: true,
  createdAt: true,
  invitedBy: { select: { fullName: true } },
} as const;

/** Invitations of the CURRENT organisation (see `MembershipsRepository` for the conventions). */
@Injectable()
export class InvitationsRepository extends TenantRepository {
  constructor(requestContext: RequestContext) {
    super(requestContext);
  }

  /** Newest first; fetches one extra row to detect another page. */
  list(tx: Tx, options: { limit: number; after?: string }): Promise<InvitationRecord[]> {
    return tx.invitation.findMany({
      where: {
        organisationId: this.organisationId,
        ...(options.after ? { id: { lt: options.after } } : {}),
      },
      orderBy: { id: 'desc' },
      take: options.limit + 1,
      select: SELECT,
    });
  }

  findById(tx: Tx, id: string): Promise<InvitationRecord | null> {
    return tx.invitation.findFirst({
      where: { id, organisationId: this.organisationId },
      select: SELECT,
    });
  }

  findPendingByEmail(tx: Tx, email: string): Promise<InvitationRecord | null> {
    return tx.invitation.findFirst({
      where: { email, status: 'PENDING', organisationId: this.organisationId },
      select: SELECT,
    });
  }

  create(
    tx: Tx,
    data: { email: string; role: Role; expiresAt: Date; invitedByUserId: string },
  ): Promise<InvitationRecord> {
    return tx.invitation.create({
      data: { ...data, organisationId: this.organisationId },
      select: SELECT,
    });
  }

  /**
   * Stores the hash of a freshly emailed token (replacing any earlier one, so only the newest link
   * works) and renews the expiry. Only a PENDING invitation can be sent.
   */
  async markSent(tx: Tx, id: string, tokenHash: string, expiresAt: Date): Promise<boolean> {
    const result = await tx.invitation.updateMany({
      where: { id, status: 'PENDING', organisationId: this.organisationId },
      data: { tokenHash, expiresAt, sendCount: { increment: 1 }, version: { increment: 1 } },
    });
    return result.count === 1;
  }

  /** PENDING to REVOKED. A spent invitation keeps no token hash (database check). */
  async revoke(tx: Tx, id: string, now: Date): Promise<boolean> {
    const result = await tx.invitation.updateMany({
      where: { id, status: 'PENDING', organisationId: this.organisationId },
      data: { status: 'REVOKED', revokedAt: now, tokenHash: null, version: { increment: 1 } },
    });
    return result.count === 1;
  }

  /**
   * Consumes an invitation: succeeds only while it is PENDING and still carries the presented token's
   * hash, so two concurrent acceptances cannot both win and a resent (newer) link invalidates the old one.
   */
  async accept(
    tx: Tx,
    id: string,
    tokenHash: string,
    acceptedByUserId: string,
    now: Date,
  ): Promise<boolean> {
    const result = await tx.invitation.updateMany({
      where: {
        id,
        status: 'PENDING',
        tokenHash,
        expiresAt: { gt: now },
        organisationId: this.organisationId,
      },
      data: {
        status: 'ACCEPTED',
        acceptedAt: now,
        acceptedByUserId,
        tokenHash: null,
        version: { increment: 1 },
      },
    });
    return result.count === 1;
  }
}
