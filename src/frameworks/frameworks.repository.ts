import { Injectable } from '@nestjs/common';
import type { Tx } from '../database/db-client.js';
import { TenantRepository } from '../database/tenant-repository.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RequestContext } from '../tenancy/request-context.js';

export interface FrameworkRecord {
  id: string;
  code: string;
  name: string;
  jurisdiction: string;
  kind: string;
}

const SELECT = { id: true, code: true, name: true, jurisdiction: true, kind: true } as const;

/** The global framework catalogue (reference data, no tenant column). */
@Injectable()
export class FrameworksRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** The active catalogue in display order. Inside a transaction when one is given. */
  listActive(tx?: Tx): Promise<FrameworkRecord[]> {
    return (tx ?? this.prisma.db).framework.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
      select: SELECT,
    });
  }
}

export interface OrganisationFrameworkRecord {
  id: string;
  frameworkId: string;
  addedAt: Date;
  removedAt: Date | null;
  version: number;
}

const OF_SELECT = {
  id: true,
  frameworkId: true,
  addedAt: true,
  removedAt: true,
  version: true,
} as const;

/** Which frameworks the CURRENT organisation declared applicable (rows are kept when one is removed). */
@Injectable()
export class OrganisationFrameworksRepository extends TenantRepository {
  constructor(requestContext: RequestContext) {
    super(requestContext);
  }

  list(tx: Tx): Promise<OrganisationFrameworkRecord[]> {
    return tx.organisationFramework.findMany({
      where: { organisationId: this.organisationId },
      select: OF_SELECT,
    });
  }

  create(tx: Tx, frameworkId: string): Promise<OrganisationFrameworkRecord> {
    return tx.organisationFramework.create({
      data: { organisationId: this.organisationId, frameworkId },
      select: OF_SELECT,
    });
  }

  /** Removes (a date) or restores (null) the framework; optimistic on `version`. */
  async setRemoved(tx: Tx, id: string, version: number, removedAt: Date | null): Promise<boolean> {
    const result = await tx.organisationFramework.updateMany({
      where: { id, version, organisationId: this.organisationId },
      data: {
        removedAt,
        version: { increment: 1 },
        ...(removedAt === null ? { addedAt: new Date() } : {}),
      },
    });
    return result.count === 1;
  }
}
