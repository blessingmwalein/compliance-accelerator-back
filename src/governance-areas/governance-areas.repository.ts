import { Injectable } from '@nestjs/common';
import type { Tx } from '../database/db-client.js';
import { TenantRepository } from '../database/tenant-repository.js';
import { RequestContext } from '../tenancy/request-context.js';

export interface GovernanceAreaRecord {
  id: string;
  name: string;
  description: string | null;
  archivedAt: Date | null;
  version: number;
}

export interface GovernanceAreaFields {
  name: string;
  description: string | null;
}

const SELECT = {
  id: true,
  name: true,
  description: true,
  archivedAt: true,
  version: true,
} as const;

/** Governance areas of the CURRENT organisation (see `MembershipsRepository` for the conventions). */
@Injectable()
export class GovernanceAreasRepository extends TenantRepository {
  constructor(requestContext: RequestContext) {
    super(requestContext);
  }

  /** Oldest first (ids are UUIDv7); fetches one extra row to detect another page. */
  list(
    tx: Tx,
    options: { limit: number; after?: string; includeArchived: boolean; q?: string },
  ): Promise<GovernanceAreaRecord[]> {
    return tx.governanceArea.findMany({
      where: {
        organisationId: this.organisationId,
        ...(options.includeArchived ? {} : { archivedAt: null }),
        ...(options.after ? { id: { gt: options.after } } : {}),
        ...(options.q ? { name: { contains: options.q, mode: 'insensitive' as const } } : {}),
      },
      orderBy: { id: 'asc' },
      take: options.limit + 1,
      select: SELECT,
    });
  }

  findById(tx: Tx, id: string): Promise<GovernanceAreaRecord | null> {
    return tx.governanceArea.findFirst({
      where: { id, organisationId: this.organisationId },
      select: SELECT,
    });
  }

  /** An ACTIVE area with this name (case-insensitive), optionally ignoring one id (the area being edited). */
  findActiveByName(tx: Tx, name: string, exceptId?: string): Promise<GovernanceAreaRecord | null> {
    return tx.governanceArea.findFirst({
      where: {
        organisationId: this.organisationId,
        archivedAt: null,
        name: { equals: name, mode: 'insensitive' },
        ...(exceptId ? { id: { not: exceptId } } : {}),
      },
      select: SELECT,
    });
  }

  create(tx: Tx, data: GovernanceAreaFields): Promise<GovernanceAreaRecord> {
    return tx.governanceArea.create({
      data: { ...data, organisationId: this.organisationId },
      select: SELECT,
    });
  }

  async update(
    tx: Tx,
    id: string,
    version: number,
    data: Partial<GovernanceAreaFields> & { archivedAt?: Date | null },
  ): Promise<boolean> {
    const result = await tx.governanceArea.updateMany({
      where: { id, version, organisationId: this.organisationId },
      data: { ...data, version: { increment: 1 } },
    });
    return result.count === 1;
  }
}
