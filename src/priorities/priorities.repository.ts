import { Injectable } from '@nestjs/common';
import type { AssessmentStatus, Prisma, RiskLevel } from '../generated/prisma/client.js';
import type { Tx } from '../database/db-client.js';
import { TenantRepository } from '../database/tenant-repository.js';
import { RequestContext } from '../tenancy/request-context.js';

/** The stored triage state of one item: the answers, the ruleset they were saved under, the override. */
export interface PriorityState {
  id: string;
  /** Untrusted JSON: always read through the domain's `cleanAnswers`. */
  answers: unknown;
  rulesetVersion: number;
  urgentOverride: boolean | null;
  importantOverride: boolean | null;
  overrideReason: string | null;
  adjustedByUserId: string | null;
  adjustedByName: string | null;
  adjustedAt: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/** What one item contributes to a quadrant count: nothing but the flags it can be derived from. */
export interface PriorityCandidate {
  itemId: string;
  urgentOverride: boolean | null;
  importantOverride: boolean | null;
  answers: unknown;
  /** True when the item has no priority row at all (nobody opened the questionnaire). */
  unanswered: boolean;
}

/** An assessment item with its subject names, its owner, its derived risk figures and its priority row. */
export interface PriorityItemRecord {
  id: string;
  assessmentId: string;
  assessmentTitle: string;
  assessmentStatus: AssessmentStatus;
  governanceAreaId: string | null;
  governanceAreaName: string | null;
  governanceAreaArchived: boolean;
  requirementId: string | null;
  requirementRef: string | null;
  requirementTitle: string | null;
  requirementKind: string | null;
  businessUnitId: string | null;
  businessUnitName: string | null;
  frameworkId: string | null;
  frameworkCode: string | null;
  ownerMembershipId: string | null;
  ownerName: string | null;
  currentMaturity: number | null;
  targetMaturity: number | null;
  gap: number | null;
  exposure: number | null;
  riskLevel: RiskLevel | null;
  rationale: string | null;
  findings: string | null;
  taskIds: string[];
  priority: PriorityState | null;
}

/** The scalar filters every priority read shares (the quadrant is derived, so it is not one of these). */
export interface PriorityFilters {
  businessUnitId?: string;
  frameworkId?: string;
  ownerMembershipId?: string;
  status?: AssessmentStatus;
  q?: string;
  /** Keyset cursor: only items with a later id (ids are UUIDv7, so id order is creation order). */
  after?: string;
}

/** The columns a priority write may set. */
export type PriorityWrite = Partial<{
  answers: Prisma.InputJsonValue;
  rulesetVersion: number;
  urgentOverride: boolean | null;
  importantOverride: boolean | null;
  overrideReason: string | null;
  adjustedByUserId: string | null;
  adjustedAt: Date | null;
}>;

const PRIORITY_SELECT = {
  id: true,
  answers: true,
  rulesetVersion: true,
  urgentOverride: true,
  importantOverride: true,
  overrideReason: true,
  adjustedByUserId: true,
  adjustedAt: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  adjustedBy: { select: { fullName: true } },
} as const;

/** Everything a list or detail row shows: the item, the names of what it is about, its owner, its tasks. */
const ITEM_SELECT = {
  id: true,
  assessmentId: true,
  governanceAreaId: true,
  requirementId: true,
  businessUnitId: true,
  frameworkId: true,
  ownerMembershipId: true,
  currentMaturity: true,
  targetMaturity: true,
  gap: true,
  exposure: true,
  riskLevel: true,
  rationale: true,
  findings: true,
  assessment: { select: { title: true, status: true } },
  governanceArea: { select: { name: true, archivedAt: true } },
  requirement: { select: { ref: true, title: true, kind: true } },
  businessUnit: { select: { name: true } },
  framework: { select: { code: true } },
  owner: { select: { user: { select: { fullName: true } } } },
  tasks: { select: { id: true } },
  priority: { select: PRIORITY_SELECT },
} as const;

/** The lean read behind the counts and the quadrant filter: the flags and nothing else. */
const CANDIDATE_SELECT = {
  id: true,
  priority: {
    select: { answers: true, urgentOverride: true, importantOverride: true },
  },
} as const;

type PriorityRow = {
  id: string;
  answers: unknown;
  rulesetVersion: number;
  urgentOverride: boolean | null;
  importantOverride: boolean | null;
  overrideReason: string | null;
  adjustedByUserId: string | null;
  adjustedAt: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  adjustedBy: { fullName: string } | null;
};

type CandidateRow = {
  id: string;
  priority: {
    answers: unknown;
    urgentOverride: boolean | null;
    importantOverride: boolean | null;
  } | null;
};

type ItemRow = Omit<
  PriorityItemRecord,
  | 'assessmentTitle'
  | 'assessmentStatus'
  | 'governanceAreaName'
  | 'governanceAreaArchived'
  | 'requirementRef'
  | 'requirementTitle'
  | 'requirementKind'
  | 'businessUnitName'
  | 'frameworkCode'
  | 'ownerName'
  | 'taskIds'
  | 'priority'
> & {
  assessment: { title: string; status: AssessmentStatus };
  governanceArea: { name: string; archivedAt: Date | null } | null;
  requirement: { ref: string; title: string; kind: string } | null;
  businessUnit: { name: string } | null;
  framework: { code: string } | null;
  owner: { user: { fullName: string } } | null;
  tasks: { id: string }[];
  priority: PriorityRow | null;
};

const toState = (row: PriorityRow): PriorityState => ({
  id: row.id,
  answers: row.answers,
  rulesetVersion: row.rulesetVersion,
  urgentOverride: row.urgentOverride,
  importantOverride: row.importantOverride,
  overrideReason: row.overrideReason,
  adjustedByUserId: row.adjustedByUserId,
  adjustedByName: row.adjustedBy?.fullName ?? null,
  adjustedAt: row.adjustedAt,
  version: row.version,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const toCandidate = ({ id, priority }: CandidateRow): PriorityCandidate => ({
  itemId: id,
  urgentOverride: priority?.urgentOverride ?? null,
  importantOverride: priority?.importantOverride ?? null,
  answers: priority?.answers ?? null,
  unanswered: priority === null,
});

const toItem = (row: ItemRow): PriorityItemRecord => ({
  ...row,
  assessmentTitle: row.assessment.title,
  assessmentStatus: row.assessment.status,
  governanceAreaName: row.governanceArea?.name ?? null,
  governanceAreaArchived: row.governanceArea?.archivedAt != null,
  requirementRef: row.requirement?.ref ?? null,
  requirementTitle: row.requirement?.title ?? null,
  requirementKind: row.requirement?.kind ?? null,
  businessUnitName: row.businessUnit?.name ?? null,
  frameworkCode: row.framework?.code ?? null,
  ownerName: row.owner?.user.fullName ?? null,
  taskIds: row.tasks.map((task) => task.id),
  priority: row.priority ? toState(row.priority) : null,
});

/**
 * The Eisenhower triage of the CURRENT organisation: the `item_priorities` rows (answers, ruleset version,
 * override) and the reads of the `assessment_items` they hang off. Nothing here derives a quadrant: the
 * flags come from the answers and are computed in the service with the pure domain rule.
 *
 * Every method takes the unit-of-work transaction and pins `organisationId`; a foreign or unknown id simply
 * returns null, which the service turns into 404.
 */
@Injectable()
export class PrioritiesRepository extends TenantRepository {
  constructor(requestContext: RequestContext) {
    super(requestContext);
  }

  private where(filters: PriorityFilters): Prisma.AssessmentItemWhereInput {
    const contains = (value: string) => ({ contains: value, mode: 'insensitive' as const });
    const text = filters.q
      ? [
          { governanceArea: { name: contains(filters.q) } },
          { requirement: { ref: contains(filters.q) } },
          { requirement: { title: contains(filters.q) } },
          { findings: contains(filters.q) },
        ]
      : null;
    return {
      organisationId: this.organisationId,
      ...(filters.after ? { id: { gt: filters.after } } : {}),
      ...(filters.businessUnitId ? { businessUnitId: filters.businessUnitId } : {}),
      ...(filters.frameworkId ? { frameworkId: filters.frameworkId } : {}),
      ...(filters.ownerMembershipId ? { ownerMembershipId: filters.ownerMembershipId } : {}),
      ...(filters.status ? { assessment: { status: filters.status } } : {}),
      AND: text ? [{ OR: text }] : [],
    };
  }

  /**
   * One keyset page of the items the filters keep, with only what a quadrant needs from them.
   * Oldest first (ids are UUIDv7); callers keep asking with the last id until they have their rows.
   */
  async scanCandidates(
    tx: Tx,
    filters: PriorityFilters,
    take: number,
  ): Promise<PriorityCandidate[]> {
    const rows = await tx.assessmentItem.findMany({
      where: this.where(filters),
      orderBy: { id: 'asc' },
      take,
      select: CANDIDATE_SELECT,
    });
    return rows.map(toCandidate);
  }

  /** The full rows of the given items of this organisation, oldest first (the page that survived the filter). */
  async findItems(tx: Tx, ids: string[]): Promise<PriorityItemRecord[]> {
    if (ids.length === 0) return [];
    const rows = await tx.assessmentItem.findMany({
      where: { organisationId: this.organisationId, id: { in: ids } },
      orderBy: { id: 'asc' },
      select: ITEM_SELECT,
    });
    return rows.map(toItem);
  }

  /** The item with all its names and its priority row, or null when it is not this organisation's. */
  async findItem(tx: Tx, itemId: string): Promise<PriorityItemRecord | null> {
    const rows = await this.findItems(tx, [itemId]);
    return rows[0] ?? null;
  }

  async createPriority(
    tx: Tx,
    itemId: string,
    data: { answers: Prisma.InputJsonValue; rulesetVersion: number },
  ): Promise<PriorityState> {
    const row = await tx.itemPriority.create({
      data: { ...data, organisationId: this.organisationId, assessmentItemId: itemId },
      select: PRIORITY_SELECT,
    });
    return toState(row);
  }

  /**
   * Optimistic locking, exactly like `GovernanceAreasRepository.update`: the row changes only when the
   * version the caller read is still current. False means someone else wrote first.
   */
  async updatePriority(tx: Tx, id: string, version: number, data: PriorityWrite): Promise<boolean> {
    const result = await tx.itemPriority.updateMany({
      where: { id, version, organisationId: this.organisationId },
      data: { ...data, version: { increment: 1 } },
    });
    return result.count === 1;
  }
}
