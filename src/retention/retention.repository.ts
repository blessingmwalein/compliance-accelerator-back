import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException, ErrorCode } from '../common/errors/app.exception.js';
import type { Tx } from '../database/db-client.js';
import { TenantRepository } from '../database/tenant-repository.js';
import type { DisposalTarget, RetentionTriggerEvent } from '../domain/registers/records.js';
import { RequestContext } from '../tenancy/request-context.js';

/** A retention rule with the names of what it points at, as the API shows it. */
export interface RuleRecord {
  id: string;
  name: string;
  classificationLevelId: string | null;
  classificationLevelName: string | null;
  classificationLevelRank: number | null;
  dataCategory: string | null;
  systemLocation: string | null;
  triggerEvent: RetentionTriggerEvent | null;
  retentionPeriodDays: number | null;
  gracePeriodDays: number | null;
  disposalMethod: string | null;
  exceptions: string | null;
  ownerMembershipId: string | null;
  ownerName: string | null;
  /** DATE columns: UTC-midnight Dates whose UTC day is the calendar day. */
  lastReviewDate: Date | null;
  nextReviewDate: Date | null;
  archivedAt: Date | null;
  version: number;
}

/** What a person writes on a rule (relations are set through their ids). */
export interface RuleFields {
  name: string;
  classificationLevelId: string | null;
  dataCategory: string | null;
  systemLocation: string | null;
  triggerEvent: RetentionTriggerEvent | null;
  retentionPeriodDays: number | null;
  gracePeriodDays: number | null;
  disposalMethod: string | null;
  exceptions: string | null;
  ownerMembershipId: string | null;
  lastReviewDate: Date | null;
  nextReviewDate: Date | null;
}

/** A legal hold, with the rule it covers and the two people who placed and released it. */
export interface HoldRecord {
  id: string;
  ruleId: string;
  ruleName: string;
  coveredKind: DisposalTarget | null;
  coveredRecordId: string | null;
  reason: string;
  placedByUserId: string;
  placedByName: string | null;
  placedAt: Date;
  releasedAt: Date | null;
  releasedByUserId: string | null;
  releasedByName: string | null;
  releaseReason: string | null;
  version: number;
}

/** One line of the disposal log: what was destroyed, when, and under which rule. */
export interface DisposalRecord {
  id: string;
  ruleId: string;
  ruleName: string;
  /** DATE column: the UTC-midnight Date whose UTC day is the day of the disposal. */
  disposedOn: Date;
  note: string;
  itemCount: number | null;
  createdByUserId: string;
  createdByName: string | null;
  createdAt: Date;
}

const RULE_SELECT = {
  id: true,
  name: true,
  classificationLevelId: true,
  dataCategory: true,
  systemLocation: true,
  triggerEvent: true,
  retentionPeriodDays: true,
  gracePeriodDays: true,
  disposalMethod: true,
  exceptions: true,
  ownerMembershipId: true,
  lastReviewDate: true,
  nextReviewDate: true,
  archivedAt: true,
  version: true,
  classificationLevel: { select: { name: true, rank: true } },
  owner: { select: { user: { select: { fullName: true } } } },
} as const;

const HOLD_SELECT = {
  id: true,
  ruleId: true,
  coveredKind: true,
  coveredRecordId: true,
  reason: true,
  placedByUserId: true,
  placedAt: true,
  releasedAt: true,
  releasedByUserId: true,
  releaseReason: true,
  version: true,
  rule: { select: { name: true } },
  placedBy: { select: { fullName: true } },
  releasedBy: { select: { fullName: true } },
} as const;

const DISPOSAL_SELECT = {
  id: true,
  ruleId: true,
  disposedOn: true,
  note: true,
  itemCount: true,
  createdByUserId: true,
  createdAt: true,
  rule: { select: { name: true } },
  createdBy: { select: { fullName: true } },
} as const;

type RuleRow = {
  classificationLevel: { name: string; rank: number } | null;
  owner: { user: { fullName: string } } | null;
} & Omit<RuleRecord, 'classificationLevelName' | 'classificationLevelRank' | 'ownerName'>;

const toRule = (row: RuleRow): RuleRecord => {
  const { classificationLevel, owner, ...rest } = row;
  return {
    ...rest,
    classificationLevelName: classificationLevel?.name ?? null,
    classificationLevelRank: classificationLevel?.rank ?? null,
    ownerName: owner?.user.fullName ?? null,
  };
};

type HoldRow = {
  rule: { name: string };
  placedBy: { fullName: string };
  releasedBy: { fullName: string } | null;
} & Omit<HoldRecord, 'ruleName' | 'placedByName' | 'releasedByName'>;

const toHold = (row: HoldRow): HoldRecord => {
  const { rule, placedBy, releasedBy, ...rest } = row;
  return {
    ...rest,
    ruleName: rule.name,
    placedByName: placedBy.fullName,
    releasedByName: releasedBy?.fullName ?? null,
  };
};

type DisposalRow = {
  rule: { name: string };
  createdBy: { fullName: string };
} & Omit<DisposalRecord, 'ruleName' | 'createdByName'>;

const toDisposal = (row: DisposalRow): DisposalRecord => {
  const { rule, createdBy, ...rest } = row;
  return { ...rest, ruleName: rule.name, createdByName: createdBy.fullName };
};

export interface ListRulesOptions {
  limit: number;
  after?: string;
  includeArchived: boolean;
  q?: string;
  classificationLevelId?: string;
  triggerEvent?: RetentionTriggerEvent;
}

export interface ListHoldsOptions {
  limit: number;
  after?: string;
  ruleId?: string;
  /** `live` = not released, `released` = already lifted. Without it both are listed. */
  state?: 'live' | 'released';
}

export interface ListDisposalsOptions {
  limit: number;
  after?: string;
  ruleId?: string;
}

/**
 * Retention rules, legal holds and the disposal log of the CURRENT organisation, all in creation order
 * (ids are UUIDv7). Nothing here deletes a rule or a hold: the tables forbid it, and the archive is a
 * status a person sets.
 */
@Injectable()
export class RetentionRepository extends TenantRepository {
  constructor(requestContext: RequestContext) {
    super(requestContext);
  }

  // ---- retention rules

  async listRules(tx: Tx, options: ListRulesOptions): Promise<RuleRecord[]> {
    const rows = await tx.retentionRule.findMany({
      where: {
        organisationId: this.organisationId,
        ...(options.includeArchived ? {} : { archivedAt: null }),
        ...(options.after ? { id: { gt: options.after } } : {}),
        ...(options.classificationLevelId
          ? { classificationLevelId: options.classificationLevelId }
          : {}),
        ...(options.triggerEvent ? { triggerEvent: options.triggerEvent } : {}),
        ...(options.q
          ? {
              OR: [
                { name: { contains: options.q, mode: 'insensitive' as const } },
                { dataCategory: { contains: options.q, mode: 'insensitive' as const } },
                { systemLocation: { contains: options.q, mode: 'insensitive' as const } },
              ],
            }
          : {}),
      },
      orderBy: { id: 'asc' },
      take: options.limit + 1,
      select: RULE_SELECT,
    });
    return rows.map(toRule);
  }

  findById(tx: Tx, id: string): Promise<RuleRecord | null> {
    return tx.retentionRule
      .findFirst({ where: { id, organisationId: this.organisationId }, select: RULE_SELECT })
      .then((row) => (row ? toRule(row) : null));
  }

  create(tx: Tx, data: RuleFields): Promise<RuleRecord> {
    return tx.retentionRule
      .create({ data: { ...data, organisationId: this.organisationId }, select: RULE_SELECT })
      .then(toRule);
  }

  async update(
    tx: Tx,
    id: string,
    version: number,
    data: Partial<RuleFields> & { archivedAt?: Date | null },
  ): Promise<boolean> {
    const result = await tx.retentionRule.updateMany({
      where: { id, version, organisationId: this.organisationId },
      data: { ...data, version: { increment: 1 } },
    });
    return result.count === 1;
  }

  /** How many live RoPA activities still point at this rule (an archived rule must not leave them behind). */
  countLiveActivities(tx: Tx, ruleId: string): Promise<number> {
    return tx.ropaActivity.count({
      where: { organisationId: this.organisationId, retentionRuleId: ruleId, archivedAt: null },
    });
  }

  // ---- legal holds

  async listHolds(tx: Tx, options: ListHoldsOptions): Promise<HoldRecord[]> {
    const rows = await tx.legalHold.findMany({
      where: {
        organisationId: this.organisationId,
        ...(options.after ? { id: { gt: options.after } } : {}),
        ...(options.ruleId ? { ruleId: options.ruleId } : {}),
        ...(options.state === 'live' ? { releasedAt: null } : {}),
        ...(options.state === 'released' ? { releasedAt: { not: null } } : {}),
      },
      orderBy: { id: 'asc' },
      take: options.limit + 1,
      select: HOLD_SELECT,
    });
    return rows.map(toHold);
  }

  findByIdHold(tx: Tx, id: string): Promise<HoldRecord | null> {
    return tx.legalHold
      .findFirst({ where: { id, organisationId: this.organisationId }, select: HOLD_SELECT })
      .then((row) => (row ? toHold(row) : null));
  }

  /** The live holds on one rule, oldest first: what a person has to lift before anything can be disposed. */
  findLiveHoldsForRule(tx: Tx, ruleId: string): Promise<HoldRecord[]> {
    return tx.legalHold
      .findMany({
        where: { organisationId: this.organisationId, ruleId, releasedAt: null },
        orderBy: { id: 'asc' },
        select: HOLD_SELECT,
      })
      .then((rows) => rows.map(toHold));
  }

  /** True when any live hold covers this rule, whether blanket or on one of its records. */
  async hasLiveHoldOnRule(tx: Tx, ruleId: string): Promise<boolean> {
    const count = await tx.legalHold.count({
      where: { organisationId: this.organisationId, ruleId, releasedAt: null },
    });
    return count > 0;
  }

  createHold(
    tx: Tx,
    data: {
      ruleId: string;
      coveredKind: DisposalTarget | null;
      coveredRecordId: string | null;
      reason: string;
      placedByUserId: string;
    },
  ): Promise<HoldRecord> {
    return tx.legalHold
      .create({
        data: { ...data, organisationId: this.organisationId },
        select: HOLD_SELECT,
      })
      .then(toHold);
  }

  /** The only write a hold ever takes: its release. Nothing else on the row may change (DB trigger). */
  async releaseHold(
    tx: Tx,
    id: string,
    version: number,
    data: { releasedAt: Date; releasedByUserId: string; releaseReason: string },
  ): Promise<boolean> {
    const result = await tx.legalHold.updateMany({
      where: { id, version, organisationId: this.organisationId, releasedAt: null },
      data: { ...data, version: { increment: 1 } },
    });
    return result.count === 1;
  }

  // ---- disposal log (append-only)

  async listDisposals(tx: Tx, options: ListDisposalsOptions): Promise<DisposalRecord[]> {
    const rows = await tx.retentionDisposal.findMany({
      where: {
        organisationId: this.organisationId,
        ...(options.after ? { id: { gt: options.after } } : {}),
        ...(options.ruleId ? { ruleId: options.ruleId } : {}),
      },
      orderBy: { id: 'asc' },
      take: options.limit + 1,
      select: DISPOSAL_SELECT,
    });
    return rows.map(toDisposal);
  }

  /** The most recent disposals under one rule, newest day first (what the rule's detail screen shows). */
  async recentDisposalsForRule(tx: Tx, ruleId: string, limit: number): Promise<DisposalRecord[]> {
    const rows = await tx.retentionDisposal.findMany({
      where: { organisationId: this.organisationId, ruleId },
      orderBy: [{ disposedOn: 'desc' }, { id: 'desc' }],
      take: limit,
      select: DISPOSAL_SELECT,
    });
    return rows.map(toDisposal);
  }

  createDisposal(
    tx: Tx,
    data: {
      ruleId: string;
      disposedOn: Date;
      note: string;
      itemCount: number | null;
      createdByUserId: string;
    },
  ): Promise<DisposalRecord> {
    return tx.retentionDisposal
      .create({
        data: { ...data, organisationId: this.organisationId },
        select: DISPOSAL_SELECT,
      })
      .then(toDisposal);
  }

  // ---- the checks that make a reference valid in THIS organisation

  async findActiveMember(tx: Tx, membershipId: string): Promise<{ id: string } | null> {
    return tx.membership.findFirst({
      where: { id: membershipId, organisationId: this.organisationId, status: 'ACTIVE' },
      select: { id: true },
    });
  }

  findLevel(tx: Tx, id: string): Promise<{ id: string; archivedAt: Date | null } | null> {
    return tx.classificationLevel.findFirst({
      where: { id, organisationId: this.organisationId },
      select: { id: true, archivedAt: true },
    });
  }

  /**
   * The record a hold names, in its own table: null when it is not one of this organisation's rows.
   * The rule the hold is filed under is context, not a second check: `fca_hold_covers` matches a named
   * record by kind and id, so a hold on one activity protects that activity wherever it sits.
   */
  findHoldTarget(tx: Tx, kind: DisposalTarget, recordId: string): Promise<{ id: string } | null> {
    const where = { id: recordId, organisationId: this.organisationId };
    const select = { id: true } as const;
    switch (kind) {
      case 'EVIDENCE':
        return tx.evidence.findFirst({ where, select });
      case 'ROPA_ACTIVITY':
        return tx.ropaActivity.findFirst({ where, select });
      case 'LAWFUL_BASIS_RECORD':
        return tx.lawfulBasisRecord.findFirst({ where, select });
      case 'RETENTION_RULE':
        return tx.retentionRule.findFirst({ where, select });
      default: {
        const _exhaustive: never = kind;
        throw new Error(`Unknown hold target ${String(_exhaustive)}`);
      }
    }
  }

  /** The organisation's row, for the time zone a review date is judged in. */
  async timezone(tx: Tx): Promise<string> {
    const row = await tx.organisation.findUnique({
      where: { id: this.organisationId },
      select: { timezone: true },
    });
    if (!row) {
      throw new AppException(ErrorCode.NotFound, HttpStatus.NOT_FOUND, 'Organisation not found.');
    }
    return row.timezone;
  }
}
