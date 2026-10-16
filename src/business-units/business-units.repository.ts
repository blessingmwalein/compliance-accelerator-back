import { Injectable } from '@nestjs/common';
import type { Tx } from '../database/db-client.js';
import { TenantRepository } from '../database/tenant-repository.js';
import { RequestContext } from '../tenancy/request-context.js';

export interface BusinessUnitRecord {
  id: string;
  name: string;
  code: string | null;
  description: string | null;
  headMembershipId: string | null;
  sensitivity: number | null;
  employeeCount: number | null;
  parentId: string | null;
  archivedAt: Date | null;
  version: number;
  head: { user: { fullName: string } } | null;
  parent: { name: string } | null;
}

/** The writable fields (relations are set through their ids). */
export interface BusinessUnitFields {
  name: string;
  code: string | null;
  description: string | null;
  headMembershipId: string | null;
  sensitivity: number | null;
  employeeCount: number | null;
  parentId: string | null;
}

const SELECT = {
  id: true,
  name: true,
  code: true,
  description: true,
  headMembershipId: true,
  sensitivity: true,
  employeeCount: true,
  parentId: true,
  archivedAt: true,
  version: true,
  head: { select: { user: { select: { fullName: true } } } },
  parent: { select: { name: true } },
} as const;

/** Business units of the CURRENT organisation (see `MembershipsRepository` for the conventions). */
@Injectable()
export class BusinessUnitsRepository extends TenantRepository {
  constructor(requestContext: RequestContext) {
    super(requestContext);
  }

  /** Oldest first (ids are UUIDv7); fetches one extra row to detect another page. */
  list(
    tx: Tx,
    options: { limit: number; after?: string; includeArchived: boolean; q?: string },
  ): Promise<BusinessUnitRecord[]> {
    return tx.businessUnit.findMany({
      where: {
        organisationId: this.organisationId,
        ...(options.includeArchived ? {} : { archivedAt: null }),
        ...(options.after ? { id: { gt: options.after } } : {}),
        ...(options.q
          ? {
              OR: [
                { name: { contains: options.q, mode: 'insensitive' as const } },
                { code: { contains: options.q, mode: 'insensitive' as const } },
              ],
            }
          : {}),
      },
      orderBy: { id: 'asc' },
      take: options.limit + 1,
      select: SELECT,
    });
  }

  findById(tx: Tx, id: string): Promise<BusinessUnitRecord | null> {
    return tx.businessUnit.findFirst({
      where: { id, organisationId: this.organisationId },
      select: SELECT,
    });
  }

  /** An ACTIVE unit with this name (case-insensitive), optionally ignoring one id (the unit being edited). */
  findActiveByName(tx: Tx, name: string, exceptId?: string): Promise<BusinessUnitRecord | null> {
    return tx.businessUnit.findFirst({
      where: {
        organisationId: this.organisationId,
        archivedAt: null,
        name: { equals: name, mode: 'insensitive' },
        ...(exceptId ? { id: { not: exceptId } } : {}),
      },
      select: SELECT,
    });
  }

  /** A unit with this code in ANY state (a code stays reserved after archiving), optionally ignoring one id. */
  findByCode(tx: Tx, code: string, exceptId?: string): Promise<BusinessUnitRecord | null> {
    return tx.businessUnit.findFirst({
      where: {
        organisationId: this.organisationId,
        code: { equals: code, mode: 'insensitive' },
        ...(exceptId ? { id: { not: exceptId } } : {}),
      },
      select: SELECT,
    });
  }

  countActiveChildren(tx: Tx, id: string): Promise<number> {
    return tx.businessUnit.count({
      where: { organisationId: this.organisationId, parentId: id, archivedAt: null },
    });
  }

  /** Whether this id is an ACTIVE member of the organisation (a unit's head must be). */
  async isActiveMember(tx: Tx, membershipId: string): Promise<boolean> {
    const count = await tx.membership.count({
      where: { id: membershipId, organisationId: this.organisationId, status: 'ACTIVE' },
    });
    return count === 1;
  }

  create(tx: Tx, data: BusinessUnitFields): Promise<BusinessUnitRecord> {
    return tx.businessUnit.create({
      data: { ...data, organisationId: this.organisationId },
      select: SELECT,
    });
  }

  async update(
    tx: Tx,
    id: string,
    version: number,
    data: Partial<BusinessUnitFields> & { archivedAt?: Date | null },
  ): Promise<boolean> {
    const result = await tx.businessUnit.updateMany({
      where: { id, version, organisationId: this.organisationId },
      data: { ...data, version: { increment: 1 } },
    });
    return result.count === 1;
  }
}
