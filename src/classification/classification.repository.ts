import { Injectable } from '@nestjs/common';
import type { Tx } from '../database/db-client.js';
import { TenantRepository } from '../database/tenant-repository.js';
import { RequestContext } from '../tenancy/request-context.js';

/** A classification level with its owner's name, as the API shows it. */
export interface LevelRecord {
  id: string;
  name: string;
  rank: number;
  description: string | null;
  handlingGuidance: string | null;
  ownerMembershipId: string | null;
  /** Joined for the display name the list shows (never stored on the row). */
  owner: { user: { fullName: string } } | null;
  /** DATE columns: UTC-midnight Dates whose UTC day is the calendar day. */
  lastReviewDate: Date | null;
  nextReviewDate: Date | null;
  archivedAt: Date | null;
  version: number;
}

/** What a person writes on a level (relations are set through their ids). */
export interface LevelFields {
  name: string;
  rank: number;
  description: string | null;
  handlingGuidance: string | null;
  ownerMembershipId: string | null;
  lastReviewDate: Date | null;
  nextReviewDate: Date | null;
}

const SELECT = {
  id: true,
  name: true,
  rank: true,
  description: true,
  handlingGuidance: true,
  ownerMembershipId: true,
  lastReviewDate: true,
  nextReviewDate: true,
  archivedAt: true,
  version: true,
  owner: { select: { user: { select: { fullName: true } } } },
} as const;

/**
 * Classification levels of the CURRENT organisation. Created rows are in creation order (ids are
 * UUIDv7); a rank is assigned so that a scheme read in id order is also a scheme in rank order.
 */
@Injectable()
export class ClassificationRepository extends TenantRepository {
  constructor(requestContext: RequestContext) {
    super(requestContext);
  }

  list(
    tx: Tx,
    options: { limit: number; after?: string; includeArchived: boolean; q?: string },
  ): Promise<LevelRecord[]> {
    return tx.classificationLevel.findMany({
      where: {
        organisationId: this.organisationId,
        ...(options.includeArchived ? {} : { archivedAt: null }),
        ...(options.after ? { id: { gt: options.after } } : {}),
        ...(options.q
          ? {
              OR: [
                { name: { contains: options.q, mode: 'insensitive' as const } },
                { description: { contains: options.q, mode: 'insensitive' as const } },
              ],
            }
          : {}),
      },
      orderBy: { id: 'asc' },
      take: options.limit + 1,
      select: SELECT,
    });
  }

  findById(tx: Tx, id: string): Promise<LevelRecord | null> {
    return tx.classificationLevel.findFirst({
      where: { id, organisationId: this.organisationId },
      select: SELECT,
    });
  }

  /** An ACTIVE level with this name (case-insensitive), optionally ignoring one id (the level being edited). */
  findActiveByName(tx: Tx, name: string, exceptId?: string): Promise<LevelRecord | null> {
    return tx.classificationLevel.findFirst({
      where: {
        organisationId: this.organisationId,
        archivedAt: null,
        name: { equals: name, mode: 'insensitive' },
        ...(exceptId ? { id: { not: exceptId } } : {}),
      },
      select: SELECT,
    });
  }

  /** A level with this rank in ANY state (a rank is never reused), optionally ignoring one id. */
  findByRank(tx: Tx, rank: number, exceptId?: string): Promise<LevelRecord | null> {
    return tx.classificationLevel.findFirst({
      where: {
        organisationId: this.organisationId,
        rank,
        ...(exceptId ? { id: { not: exceptId } } : {}),
      },
      select: SELECT,
    });
  }

  /** The highest rank in use, archived levels included: a new level is appended after it. */
  async maxRank(tx: Tx): Promise<number> {
    const row = await tx.classificationLevel.findFirst({
      where: { organisationId: this.organisationId },
      orderBy: { rank: 'desc' },
      select: { rank: true },
    });
    return row?.rank ?? 0;
  }

  /** How many live RoPA activities and retention rules still sit at this level. */
  async countReferences(tx: Tx, id: string): Promise<number> {
    const [activities, rules] = await Promise.all([
      tx.ropaActivity.count({
        where: { organisationId: this.organisationId, classificationLevelId: id, archivedAt: null },
      }),
      tx.retentionRule.count({
        where: { organisationId: this.organisationId, classificationLevelId: id, archivedAt: null },
      }),
    ]);
    return activities + rules;
  }

  /** Whether this id is an ACTIVE member of the organisation (a level's owner must be). */
  async isActiveMember(tx: Tx, membershipId: string): Promise<boolean> {
    const count = await tx.membership.count({
      where: { id: membershipId, organisationId: this.organisationId, status: 'ACTIVE' },
    });
    return count === 1;
  }

  create(tx: Tx, data: LevelFields): Promise<LevelRecord> {
    return tx.classificationLevel.create({
      data: { ...data, organisationId: this.organisationId },
      select: SELECT,
    });
  }

  async update(
    tx: Tx,
    id: string,
    version: number,
    data: Partial<LevelFields> & { archivedAt?: Date | null },
  ): Promise<boolean> {
    const result = await tx.classificationLevel.updateMany({
      where: { id, version, organisationId: this.organisationId },
      data: { ...data, version: { increment: 1 } },
    });
    return result.count === 1;
  }
}
