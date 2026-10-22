import { Injectable } from '@nestjs/common';
import type { Tx } from '../database/db-client.js';
import { TenantRepository } from '../database/tenant-repository.js';
import { RequestContext } from '../tenancy/request-context.js';

export interface GovernanceAreaRecord {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  controlObjective: string | null;
  archivedAt: Date | null;
  version: number;
}

export interface GovernanceAreaFields {
  name: string;
  description: string | null;
  category: string | null;
  controlObjective: string | null;
}

/** One cell of a row's own reference text: what the organisation cites on this topic in this framework. */
export interface AreaNoteField {
  frameworkId: string;
  note: string | null;
}

const SELECT = {
  id: true,
  name: true,
  description: true,
  category: true,
  controlObjective: true,
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

  /** The ids of these catalogue frameworks that still exist and are active (a retired one is not writable). */
  async findActiveFrameworkIds(tx: Tx, ids: string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const rows = await tx.framework.findMany({
      where: { id: { in: ids }, isActive: true },
      select: { id: true },
    });
    return new Set(rows.map((row) => row.id));
  }

  /**
   * Replaces the row's reference notes with the given set: a cell whose note is null is removed rather than
   * stored empty, so an absent row and an empty string cannot mean the same thing twice.
   */
  async replaceNotes(tx: Tx, areaId: string, notes: AreaNoteField[]): Promise<void> {
    await tx.areaFrameworkNote.deleteMany({
      where: { organisationId: this.organisationId, areaId },
    });
    const filled = notes.filter((entry) => entry.note !== null);
    if (filled.length === 0) return;
    await tx.areaFrameworkNote.createMany({
      data: filled.map((entry) => ({
        organisationId: this.organisationId,
        areaId,
        frameworkId: entry.frameworkId,
        // the DTO trims, and the database check refuses a blank; this is the belt behind it
        note: (entry.note ?? '').trim(),
      })),
    });
  }

  /** Removes every reference note of one area. Idempotent: an area with no notes has nothing to remove. */
  async deleteNotes(tx: Tx, areaId: string): Promise<number> {
    const result = await tx.areaFrameworkNote.deleteMany({
      where: { organisationId: this.organisationId, areaId },
    });
    return result.count;
  }
}
