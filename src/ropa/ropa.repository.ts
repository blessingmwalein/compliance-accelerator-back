import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException, ErrorCode } from '../common/errors/app.exception.js';
import type { Tx } from '../database/db-client.js';
import { TenantRepository } from '../database/tenant-repository.js';
import type {
  LawfulBasisKind,
  LawfulBasisReviewStatus,
  RopaActivityStatus,
} from '../domain/registers/records.js';
import { RequestContext } from '../tenancy/request-context.js';

/**
 * A basis record that justifies one processing activity. The link is owned by the basis side
 * (`LawfulBasisRecord.processingActivityId`), because an activity can be justified more than once; the
 * register reads the records that point at it.
 */
export interface RopaBasisLink {
  id: string;
  basis: LawfulBasisKind;
  purpose: string;
  reviewStatus: LawfulBasisReviewStatus;
}

/** A processing activity with the names of what it points at, as the API shows it. */
export interface ActivityRecord {
  id: string;
  name: string;
  businessUnitId: string | null;
  businessUnitName: string | null;
  classificationLevelId: string | null;
  classificationLevelName: string | null;
  classificationLevelRank: number | null;
  retentionRuleId: string | null;
  retentionRuleName: string | null;
  /** The basis records that justify this activity, oldest first. Empty means none has been stated. */
  lawfulBasis: RopaBasisLink[];
  purpose: string | null;
  dataSubjects: string | null;
  personalDataCategories: string | null;
  recipients: string | null;
  processors: string | null;
  retention: string | null;
  internationalTransfers: string | null;
  transferCountries: string | null;
  securityMeasures: string | null;
  ownerMembershipId: string | null;
  ownerName: string | null;
  status: RopaActivityStatus;
  reviewIntervalDays: number | null;
  reviewLeadDays: number | null;
  /** DATE columns: UTC-midnight Dates whose UTC day is the calendar day. */
  lastReviewDate: Date | null;
  nextReviewDate: Date | null;
  archivedAt: Date | null;
  version: number;
}

/** What a person writes on an activity (relations are set through their ids, dates as `DATE` instants). */
export interface ActivityFields {
  name: string;
  businessUnitId: string | null;
  classificationLevelId: string | null;
  retentionRuleId: string | null;
  purpose: string | null;
  dataSubjects: string | null;
  personalDataCategories: string | null;
  recipients: string | null;
  processors: string | null;
  retention: string | null;
  internationalTransfers: string | null;
  transferCountries: string | null;
  securityMeasures: string | null;
  ownerMembershipId: string | null;
  status: RopaActivityStatus;
  reviewIntervalDays: number | null;
  reviewLeadDays: number | null;
  lastReviewDate: Date | null;
  nextReviewDate: Date | null;
}

const SELECT = {
  id: true,
  name: true,
  businessUnitId: true,
  classificationLevelId: true,
  retentionRuleId: true,
  purpose: true,
  dataSubjects: true,
  personalDataCategories: true,
  recipients: true,
  processors: true,
  retention: true,
  internationalTransfers: true,
  transferCountries: true,
  securityMeasures: true,
  ownerMembershipId: true,
  status: true,
  reviewIntervalDays: true,
  reviewLeadDays: true,
  lastReviewDate: true,
  nextReviewDate: true,
  archivedAt: true,
  version: true,
  businessUnit: { select: { name: true } },
  classificationLevel: { select: { name: true, rank: true } },
  retentionRule: { select: { name: true } },
  owner: { select: { user: { select: { fullName: true } } } },
  // An archived basis no longer claims to justify anything, so the register reads the live ones only.
  lawfulBasisRecords: {
    where: { archivedAt: null },
    orderBy: { id: 'asc' as const },
    select: { id: true, basis: true, purpose: true, reviewStatus: true },
  },
} as const;

/** The flat names the API shows come from the joined rows, never from the client. */
const toRecord = (
  row: {
    businessUnit: { name: string } | null;
    classificationLevel: { name: string; rank: number } | null;
    retentionRule: { name: string } | null;
    owner: { user: { fullName: string } } | null;
    lawfulBasisRecords: readonly RopaBasisLink[];
  } & Omit<
    ActivityRecord,
    | 'businessUnitName'
    | 'classificationLevelName'
    | 'classificationLevelRank'
    | 'retentionRuleName'
    | 'ownerName'
    | 'lawfulBasis'
  >,
): ActivityRecord => {
  const { businessUnit, classificationLevel, retentionRule, owner, lawfulBasisRecords, ...rest } =
    row;
  return {
    ...rest,
    businessUnitName: businessUnit?.name ?? null,
    classificationLevelName: classificationLevel?.name ?? null,
    classificationLevelRank: classificationLevel?.rank ?? null,
    retentionRuleName: retentionRule?.name ?? null,
    ownerName: owner?.user.fullName ?? null,
    lawfulBasis: [...lawfulBasisRecords],
  };
};

export interface ListOptions {
  limit: number;
  after?: string;
  q?: string;
  status?: RopaActivityStatus;
  businessUnitId?: string;
  classificationLevelId?: string;
  retentionRuleId?: string;
}

/**
 * RoPA activities of the CURRENT organisation, in creation order (ids are UUIDv7). Archived activities
 * are excluded unless asked for: an archived line still prints in the register export, it just is not
 * offered to be linked again.
 */
@Injectable()
export class RopaRepository extends TenantRepository {
  constructor(requestContext: RequestContext) {
    super(requestContext);
  }

  async list(tx: Tx, options: ListOptions): Promise<ActivityRecord[]> {
    const rows = await tx.ropaActivity.findMany({
      where: {
        organisationId: this.organisationId,
        // `status` filters exactly; without it the list simply excludes archived lines.
        ...(options.status ? { status: options.status } : { status: { not: 'ARCHIVED' as const } }),
        ...(options.after ? { id: { gt: options.after } } : {}),
        ...(options.businessUnitId ? { businessUnitId: options.businessUnitId } : {}),
        ...(options.classificationLevelId
          ? { classificationLevelId: options.classificationLevelId }
          : {}),
        ...(options.retentionRuleId ? { retentionRuleId: options.retentionRuleId } : {}),
        ...(options.q
          ? {
              OR: [
                { name: { contains: options.q, mode: 'insensitive' as const } },
                { purpose: { contains: options.q, mode: 'insensitive' as const } },
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

  findById(tx: Tx, id: string): Promise<ActivityRecord | null> {
    return tx.ropaActivity
      .findFirst({ where: { id, organisationId: this.organisationId }, select: SELECT })
      .then((row) => (row ? toRecord(row) : null));
  }

  /** Every activity of this organisation that is not archived (the monitor counts these). */
  async listLive(tx: Tx): Promise<ActivityRecord[]> {
    const rows = await tx.ropaActivity.findMany({
      where: { organisationId: this.organisationId, archivedAt: null },
      orderBy: { id: 'asc' },
      select: SELECT,
    });
    return rows.map(toRecord);
  }

  create(tx: Tx, data: ActivityFields): Promise<ActivityRecord> {
    return tx.ropaActivity
      .create({ data: { ...data, organisationId: this.organisationId }, select: SELECT })
      .then(toRecord);
  }

  async update(
    tx: Tx,
    id: string,
    version: number,
    data: Partial<ActivityFields> & { archivedAt?: Date | null },
  ): Promise<boolean> {
    const result = await tx.ropaActivity.updateMany({
      where: { id, version, organisationId: this.organisationId },
      data: { ...data, version: { increment: 1 } },
    });
    return result.count === 1;
  }

  // ---- evidence links

  /** The ids of the evidence files linked to this activity, oldest link first. */
  async evidenceIdsFor(tx: Tx, activityId: string): Promise<string[]> {
    const rows = await tx.ropaActivityEvidence.findMany({
      where: { organisationId: this.organisationId, activityId },
      orderBy: { id: 'asc' },
      select: { evidenceId: true },
    });
    return rows.map((row) => row.evidenceId);
  }

  async findEvidence(tx: Tx, evidenceId: string): Promise<{ id: string; title: string } | null> {
    return tx.evidence.findFirst({
      where: { id: evidenceId, organisationId: this.organisationId },
      select: { id: true, title: true },
    });
  }

  /** Idempotent: an existing link is kept, not duplicated. Returns false when it was already there. */
  async linkEvidence(
    tx: Tx,
    activityId: string,
    evidenceId: string,
    byUserId: string,
  ): Promise<boolean> {
    const existing = await tx.ropaActivityEvidence.findFirst({
      where: { organisationId: this.organisationId, activityId, evidenceId },
      select: { id: true },
    });
    if (existing) return false;
    await tx.ropaActivityEvidence.create({
      data: {
        organisationId: this.organisationId,
        activityId,
        evidenceId,
        linkedByUserId: byUserId,
      },
    });
    return true;
  }

  async unlinkEvidence(tx: Tx, activityId: string, evidenceId: string): Promise<boolean> {
    const result = await tx.ropaActivityEvidence.deleteMany({
      where: { organisationId: this.organisationId, activityId, evidenceId },
    });
    return result.count === 1;
  }

  // ---- the lawful basis that justifies the activity

  /**
   * The basis stated while the activity is being recorded: a DRAFT record that points here. Its approval is
   * a separate decision with its own endpoint, so nothing here claims the processing is justified yet.
   */
  createBasisRecord(
    tx: Tx,
    data: { basis: LawfulBasisKind; purpose: string; processingActivityId: string },
  ): Promise<RopaBasisLink> {
    return tx.lawfulBasisRecord.create({
      data: {
        organisationId: this.organisationId,
        basis: data.basis,
        purpose: data.purpose,
        processingActivityId: data.processingActivityId,
        reviewStatus: 'DRAFT',
      },
      select: { id: true, basis: true, purpose: true, reviewStatus: true },
    });
  }

  /** A basis record of this organisation, with the activity it currently points at. */
  findBasisRecord(
    tx: Tx,
    id: string,
  ): Promise<{
    id: string;
    purpose: string;
    processingActivityId: string | null;
    archivedAt: Date | null;
  } | null> {
    return tx.lawfulBasisRecord.findFirst({
      where: { id, organisationId: this.organisationId },
      select: { id: true, purpose: true, processingActivityId: true, archivedAt: true },
    });
  }

  /**
   * Detaches a basis from this activity. The version moves so a lawful-basis screen that still holds the old
   * row fails with `VERSION_CONFLICT` rather than quietly pointing the link back.
   */
  async unlinkBasisRecord(tx: Tx, activityId: string, recordId: string): Promise<boolean> {
    const result = await tx.lawfulBasisRecord.updateMany({
      where: {
        id: recordId,
        organisationId: this.organisationId,
        processingActivityId: activityId,
      },
      data: { processingActivityId: null, version: { increment: 1 } },
    });
    return result.count === 1;
  }

  // ---- the checks that make an activity valid in THIS organisation

  async findActiveMember(tx: Tx, membershipId: string): Promise<{ id: string } | null> {
    return tx.membership.findFirst({
      where: { id: membershipId, organisationId: this.organisationId, status: 'ACTIVE' },
      select: { id: true },
    });
  }

  /** A business unit of this organisation, in any state (an archived one still holds processing). */
  findBusinessUnit(tx: Tx, id: string): Promise<{ id: string } | null> {
    return tx.businessUnit.findFirst({
      where: { id, organisationId: this.organisationId },
      select: { id: true },
    });
  }

  findLevel(tx: Tx, id: string): Promise<{ id: string; archivedAt: Date | null } | null> {
    return tx.classificationLevel.findFirst({
      where: { id, organisationId: this.organisationId },
      select: { id: true, archivedAt: true },
    });
  }

  findRule(tx: Tx, id: string): Promise<{ id: string; archivedAt: Date | null } | null> {
    return tx.retentionRule.findFirst({
      where: { id, organisationId: this.organisationId },
      select: { id: true, archivedAt: true },
    });
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
