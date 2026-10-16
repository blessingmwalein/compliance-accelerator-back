import { Injectable } from '@nestjs/common';
import type { Tx } from '../database/db-client.js';
import { TenantRepository } from '../database/tenant-repository.js';
import type { Role } from '../permissions/catalogue.js';
import { RequestContext } from '../tenancy/request-context.js';
import type { MemberStatus } from './members.dto.js';

export interface MembershipRecord {
  id: string;
  userId: string;
  role: Role;
  status: MemberStatus;
  version: number;
  createdAt: Date;
  user: { email: string; fullName: string; isActive: boolean };
}

const SELECT = {
  id: true,
  userId: true,
  role: true,
  status: true,
  version: true,
  createdAt: true,
  user: { select: { email: true, fullName: true, isActive: true } },
} as const;

/**
 * Memberships of the CURRENT organisation. Every method takes the caller's transaction (the
 * unit of work sets the tenant for row-level security) and the organisation comes from the request
 * scope, never from an argument.
 */
@Injectable()
export class MembershipsRepository extends TenantRepository {
  constructor(requestContext: RequestContext) {
    super(requestContext);
  }

  /** Oldest first (ids are UUIDv7, so id order is joining order). Fetches one extra row to detect another page. */
  list(tx: Tx, options: { limit: number; after?: string }): Promise<MembershipRecord[]> {
    return tx.membership.findMany({
      where: {
        organisationId: this.organisationId,
        ...(options.after ? { id: { gt: options.after } } : {}),
      },
      orderBy: { id: 'asc' },
      take: options.limit + 1,
      select: SELECT,
    });
  }

  findById(tx: Tx, id: string): Promise<MembershipRecord | null> {
    return tx.membership.findFirst({
      where: { id, organisationId: this.organisationId },
      select: SELECT,
    });
  }

  findByUser(tx: Tx, userId: string): Promise<MembershipRecord | null> {
    return tx.membership.findFirst({
      where: { userId, organisationId: this.organisationId },
      select: SELECT,
    });
  }

  create(tx: Tx, data: { userId: string; role: Role }): Promise<MembershipRecord> {
    return tx.membership.create({
      data: { organisationId: this.organisationId, userId: data.userId, role: data.role },
      select: SELECT,
    });
  }

  /**
   * Locks the organisation's active owners until the transaction ends, and returns their ids. Taken
   * before any change that could remove an owner, so two concurrent changes cannot both pass the
   * "at least one owner remains" check.
   */
  async lockActiveOwners(tx: Tx): Promise<string[]> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM memberships
      WHERE organisation_id = ${this.organisationId}::uuid
        AND role = 'COMPANY_OWNER' AND status = 'ACTIVE'
      ORDER BY id
      FOR UPDATE`;
    return rows.map((row) => row.id);
  }

  /** Optimistic update: false when the row changed since `version` was read (or is not in this organisation). */
  async update(
    tx: Tx,
    id: string,
    version: number,
    data: { role?: Role; status?: MemberStatus },
  ): Promise<boolean> {
    const result = await tx.membership.updateMany({
      where: { id, version, organisationId: this.organisationId },
      data: { ...data, version: { increment: 1 } },
    });
    return result.count === 1;
  }
}
