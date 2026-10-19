import { Injectable } from '@nestjs/common';
import type { Tx } from '../database/db-client.js';
import { TenantRepository } from '../database/tenant-repository.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { RiskLevel } from '../domain/scoring/methodologies.js';
import { RequestContext } from '../tenancy/request-context.js';

/** One item with the names it points at, so a table needs no extra calls. */
export interface ItemRecord {
  id: string;
  assessmentId: string;
  governanceAreaId: string | null;
  governanceAreaName: string | null;
  requirementId: string | null;
  requirementRef: string | null;
  frameworkId: string | null;
  frameworkCode: string | null;
  businessUnitId: string | null;
  businessUnitName: string | null;
  currentMaturity: number | null;
  targetMaturity: number | null;
  sensitivity: number | null;
  severity: number | null;
  likelihood: number | null;
  gap: number | null;
  exposure: number | null;
  riskLevel: RiskLevel | null;
  rationale: string | null;
  findings: string | null;
  ownerMembershipId: string | null;
  ownerName: string | null;
  lastReviewDate: Date | null;
  nextReviewDate: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/** What an item is about: two items of one assessment with the same subject are the same question. */
export interface ItemSubject {
  governanceAreaId: string | null;
  requirementId: string | null;
  businessUnitId: string | null;
  frameworkId: string | null;
}

/** The ratings an item is scored from (null = not assessed). */
export interface ItemRatings {
  currentMaturity: number | null;
  targetMaturity: number | null;
  sensitivity: number | null;
  severity: number | null;
  likelihood: number | null;
}

export interface ItemCreateFields extends ItemSubject, ItemRatings {
  assessmentId: string;
  gap: number | null;
  exposure: number | null;
  riskLevel: RiskLevel | null;
  rationale: string | null;
  findings: string | null;
  ownerMembershipId: string | null;
  lastReviewDate: Date | null;
  nextReviewDate: Date | null;
}

export type ItemChanges = Partial<Omit<ItemCreateFields, 'assessmentId' | 'id'>>;

/** The six numbers a summary is rolled up from. */
export interface ItemMetrics {
  currentMaturity: number | null;
  gap: number | null;
  exposure: number | null;
  riskLevel: RiskLevel | null;
}

const SELECT = {
  id: true,
  assessmentId: true,
  governanceAreaId: true,
  requirementId: true,
  frameworkId: true,
  businessUnitId: true,
  currentMaturity: true,
  targetMaturity: true,
  sensitivity: true,
  severity: true,
  likelihood: true,
  gap: true,
  exposure: true,
  riskLevel: true,
  rationale: true,
  findings: true,
  ownerMembershipId: true,
  lastReviewDate: true,
  nextReviewDate: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  governanceArea: { select: { name: true } },
  requirement: {
    select: {
      ref: true,
      frameworkVersion: { select: { framework: { select: { code: true } } } },
    },
  },
  businessUnit: { select: { name: true } },
  framework: { select: { code: true } },
  owner: { select: { user: { select: { fullName: true } } } },
} as const;

type Row = Prisma.AssessmentItemGetPayload<{ select: typeof SELECT }>;

const toRecord = (row: Row): ItemRecord => ({
  id: row.id,
  assessmentId: row.assessmentId,
  governanceAreaId: row.governanceAreaId,
  governanceAreaName: row.governanceArea?.name ?? null,
  requirementId: row.requirementId,
  requirementRef: row.requirement?.ref ?? null,
  // a requirement carries its own framework: an item may name one explicitly, and that is what is shown
  frameworkCode: row.framework?.code ?? row.requirement?.frameworkVersion.framework.code ?? null,
  frameworkId: row.frameworkId,
  businessUnitId: row.businessUnitId,
  businessUnitName: row.businessUnit?.name ?? null,
  currentMaturity: row.currentMaturity,
  targetMaturity: row.targetMaturity,
  sensitivity: row.sensitivity,
  severity: row.severity,
  likelihood: row.likelihood,
  gap: row.gap,
  exposure: row.exposure,
  riskLevel: row.riskLevel,
  rationale: row.rationale,
  findings: row.findings,
  ownerMembershipId: row.ownerMembershipId,
  ownerName: row.owner?.user.fullName ?? null,
  lastReviewDate: row.lastReviewDate,
  nextReviewDate: row.nextReviewDate,
  version: row.version,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

/**
 * Items of the CURRENT organisation, plus the lookups that decide whether a subject may be used at all:
 * the organisation's own active area, unit and member, and global framework content of a USABLE version.
 * See `MembershipsRepository` for the conventions.
 */
@Injectable()
export class AssessmentItemsRepository extends TenantRepository {
  constructor(requestContext: RequestContext) {
    super(requestContext);
  }

  async list(
    tx: Tx,
    options: {
      assessmentId: string;
      limit: number;
      after?: string;
      businessUnitId?: string;
      frameworkId?: string;
      governanceAreaId?: string;
      ratedOnly?: boolean;
    },
  ): Promise<ItemRecord[]> {
    const rows = await tx.assessmentItem.findMany({
      where: {
        organisationId: this.organisationId,
        assessmentId: options.assessmentId,
        ...(options.after ? { id: { gt: options.after } } : {}),
        ...(options.businessUnitId ? { businessUnitId: options.businessUnitId } : {}),
        ...(options.frameworkId ? { frameworkId: options.frameworkId } : {}),
        ...(options.governanceAreaId ? { governanceAreaId: options.governanceAreaId } : {}),
        ...(options.ratedOnly
          ? {
              OR: [
                { sensitivity: { not: null } },
                { severity: { not: null } },
                { likelihood: { not: null } },
                { currentMaturity: { not: null } },
              ],
            }
          : {}),
      },
      orderBy: { id: 'asc' },
      take: options.limit + 1,
      select: SELECT,
    });
    return rows.map(toRecord);
  }

  findById(tx: Tx, id: string): Promise<ItemRecord | null> {
    return tx.assessmentItem
      .findFirst({ where: { id, organisationId: this.organisationId }, select: SELECT })
      .then((row) => (row ? toRecord(row) : null));
  }

  /** Every item of one assessment (a cycle holds at most a few thousand: no pagination here). */
  async itemsOf(tx: Tx, assessmentId: string): Promise<ItemRecord[]> {
    const rows = await tx.assessmentItem.findMany({
      where: { organisationId: this.organisationId, assessmentId },
      orderBy: { id: 'asc' },
      select: SELECT,
    });
    return rows.map(toRecord);
  }

  /**
   * Only the four numbers a summary rolls up, for the items the filters leave. Kept apart from `itemsOf`:
   * a roll-up over a whole cycle must not pay for names, links and free text it never reads.
   */
  metricsOf(
    tx: Tx,
    options: { assessmentId: string; businessUnitId?: string; frameworkId?: string },
  ): Promise<ItemMetrics[]> {
    return tx.assessmentItem.findMany({
      where: {
        organisationId: this.organisationId,
        assessmentId: options.assessmentId,
        ...(options.businessUnitId ? { businessUnitId: options.businessUnitId } : {}),
        ...(options.frameworkId ? { frameworkId: options.frameworkId } : {}),
      },
      select: { currentMaturity: true, gap: true, exposure: true, riskLevel: true },
    });
  }

  /** The item with this exact subject in this assessment, if any (AC-GOV-01: never duplicates). */
  findBySubject(tx: Tx, assessmentId: string, subject: ItemSubject): Promise<ItemRecord | null> {
    return tx.assessmentItem
      .findFirst({
        where: { organisationId: this.organisationId, assessmentId, ...subject },
        select: SELECT,
      })
      .then((row) => (row ? toRecord(row) : null));
  }

  count(tx: Tx, assessmentId: string): Promise<number> {
    return tx.assessmentItem.count({
      where: { organisationId: this.organisationId, assessmentId },
    });
  }

  create(tx: Tx, fields: ItemCreateFields): Promise<ItemRecord> {
    return tx.assessmentItem
      .create({
        data: { ...fields, organisationId: this.organisationId },
        select: SELECT,
      })
      .then(toRecord);
  }

  async update(tx: Tx, id: string, version: number, changes: ItemChanges): Promise<boolean> {
    const result = await tx.assessmentItem.updateMany({
      where: { id, version, organisationId: this.organisationId },
      data: { ...changes, version: { increment: 1 } },
    });
    return result.count === 1;
  }

  /** Removes the item and its evidence links (the files themselves stay: they may be linked elsewhere). */
  async remove(tx: Tx, id: string): Promise<boolean> {
    await tx.assessmentItemEvidence.deleteMany({
      where: { organisationId: this.organisationId, assessmentItemId: id },
    });
    const result = await tx.assessmentItem.deleteMany({
      where: { id, organisationId: this.organisationId },
    });
    return result.count === 1;
  }

  /** The items of these assessments that an open remediation task still refers to. */
  async taskReferenceCount(tx: Tx, assessmentId: string): Promise<number> {
    return tx.remediationTask.count({
      where: {
        organisationId: this.organisationId,
        assessmentItemId: {
          in: (
            await tx.assessmentItem.findMany({
              where: { organisationId: this.organisationId, assessmentId },
              select: { id: true },
            })
          ).map((row) => row.id),
        },
      },
    });
  }

  /** Deletes an assessment's items with their evidence links; returns how many went. */
  async removeAllOf(tx: Tx, assessmentId: string): Promise<number> {
    const itemIds = (
      await tx.assessmentItem.findMany({
        where: { organisationId: this.organisationId, assessmentId },
        select: { id: true },
      })
    ).map((row) => row.id);
    if (itemIds.length === 0) return 0;
    await tx.assessmentItemEvidence.deleteMany({
      where: { organisationId: this.organisationId, assessmentItemId: { in: itemIds } },
    });
    const result = await tx.assessmentItem.deleteMany({
      where: { organisationId: this.organisationId, id: { in: itemIds } },
    });
    return result.count;
  }

  // --- the evidence links of an item -------------------------------------------------------------

  async evidenceIdsOf(tx: Tx, itemId: string): Promise<string[]> {
    const rows = await tx.assessmentItemEvidence.findMany({
      where: { organisationId: this.organisationId, assessmentItemId: itemId },
      select: { evidenceId: true },
    });
    return rows.map((row) => row.evidenceId);
  }

  /** The links of many items in one query, for a list page. */
  async evidenceIdsByItem(tx: Tx, itemIds: readonly string[]): Promise<Map<string, string[]>> {
    if (itemIds.length === 0) return new Map();
    const rows = await tx.assessmentItemEvidence.findMany({
      where: { organisationId: this.organisationId, assessmentItemId: { in: [...itemIds] } },
      select: { assessmentItemId: true, evidenceId: true },
    });
    const byItem = new Map<string, string[]>();
    for (const row of rows) {
      const list = byItem.get(row.assessmentItemId) ?? [];
      list.push(row.evidenceId);
      byItem.set(row.assessmentItemId, list);
    }
    return byItem;
  }

  /** Ids of the evidence rows of this organisation that these ids name (a foreign id yields nothing). */
  async existingEvidenceIds(tx: Tx, evidenceIds: readonly string[]): Promise<Set<string>> {
    if (evidenceIds.length === 0) return new Set();
    const rows = await tx.evidence.findMany({
      where: { organisationId: this.organisationId, id: { in: [...evidenceIds] } },
      select: { id: true },
    });
    return new Set(rows.map((row) => row.id));
  }

  async linkEvidence(
    tx: Tx,
    itemId: string,
    evidenceId: string,
    linkedByUserId: string,
  ): Promise<boolean> {
    const existing = await tx.assessmentItemEvidence.findFirst({
      where: { organisationId: this.organisationId, assessmentItemId: itemId, evidenceId },
      select: { id: true },
    });
    if (existing) return false;
    await tx.assessmentItemEvidence.create({
      data: {
        organisationId: this.organisationId,
        assessmentItemId: itemId,
        evidenceId,
        linkedByUserId,
      },
    });
    return true;
  }

  async unlinkEvidence(tx: Tx, itemId: string, evidenceId: string): Promise<boolean> {
    const result = await tx.assessmentItemEvidence.deleteMany({
      where: { organisationId: this.organisationId, assessmentItemId: itemId, evidenceId },
    });
    return result.count === 1;
  }

  // --- what a subject may point at --------------------------------------------------------------

  /** An ACTIVE governance area of this organisation. */
  activeGovernanceArea(tx: Tx, id: string): Promise<{ id: string; name: string } | null> {
    return tx.governanceArea.findFirst({
      where: { id, organisationId: this.organisationId, archivedAt: null },
      select: { id: true, name: true },
    });
  }

  /** An ACTIVE area with this name (case-insensitive), for applying a template. */
  findActiveAreaByName(tx: Tx, name: string): Promise<{ id: string; name: string } | null> {
    return tx.governanceArea.findFirst({
      where: {
        organisationId: this.organisationId,
        archivedAt: null,
        name: { equals: name, mode: 'insensitive' },
      },
      select: { id: true, name: true },
    });
  }

  createArea(
    tx: Tx,
    name: string,
    description: string | null,
  ): Promise<{ id: string; name: string }> {
    return tx.governanceArea.create({
      data: { organisationId: this.organisationId, name, description },
      select: { id: true, name: true },
    });
  }

  /** An ACTIVE business unit of this organisation. */
  activeBusinessUnit(tx: Tx, id: string): Promise<{ id: string; name: string } | null> {
    return tx.businessUnit.findFirst({
      where: { id, organisationId: this.organisationId, archivedAt: null },
      select: { id: true, name: true },
    });
  }

  /** A framework this organisation has made applicable (Company Settings). */
  async applicableFramework(tx: Tx, id: string): Promise<{ id: string; code: string } | null> {
    const row = await tx.organisationFramework.findFirst({
      where: { organisationId: this.organisationId, frameworkId: id, removedAt: null },
      select: { frameworkId: true, framework: { select: { code: true } } },
    });
    return row ? { id: row.frameworkId, code: row.framework.code } : null;
  }

  /** An ACTIVE membership of this organisation: the accountable owner of an item. */
  async activeMembership(tx: Tx, id: string): Promise<{ id: string; fullName: string } | null> {
    const row = await tx.membership.findFirst({
      where: { id, organisationId: this.organisationId, status: 'ACTIVE' },
      select: { id: true, user: { select: { fullName: true } } },
    });
    return row ? { id: row.id, fullName: row.user.fullName } : null;
  }

  /**
   * A requirement of a VERIFIED or PUBLISHED version: an item may cite real framework content only. The
   * version and framework are global reference data, so no tenant column is involved.
   */
  async usableRequirement(
    tx: Tx,
    id: string,
  ): Promise<{ id: string; ref: string; frameworkId: string } | null> {
    const row = await tx.requirement.findFirst({
      where: { id, frameworkVersion: { status: { in: ['VERIFIED', 'PUBLISHED'] } } },
      select: { id: true, ref: true, frameworkVersion: { select: { frameworkId: true } } },
    });
    return row ? { id: row.id, ref: row.ref, frameworkId: row.frameworkVersion.frameworkId } : null;
  }
}
