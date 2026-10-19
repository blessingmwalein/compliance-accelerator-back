import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException, ErrorCode } from '../common/errors/app.exception.js';
import type { Tx } from '../database/db-client.js';
import { TenantRepository } from '../database/tenant-repository.js';
import type { LawfulBasisKind, LawfulBasisReviewStatus } from '../domain/registers/records.js';
import { RequestContext } from '../tenancy/request-context.js';

/** A basis record with the names of what it points at, as the API shows it. */
export interface BasisRecord {
  id: string;
  purpose: string;
  basis: LawfulBasisKind;
  frameworkId: string | null;
  frameworkCode: string | null;
  requirementId: string | null;
  requirementRef: string | null;
  requirementTitle: string | null;
  processingActivityId: string | null;
  processingActivityName: string | null;
  justification: string | null;
  reviewStatus: LawfulBasisReviewStatus;
  ownerMembershipId: string | null;
  ownerName: string | null;
  reviewIntervalDays: number | null;
  reviewLeadDays: number | null;
  /** DATE columns: UTC-midnight Dates whose UTC day is the calendar day. */
  lastReviewDate: Date | null;
  nextReviewDate: Date | null;
  archivedAt: Date | null;
  version: number;
}

/** What a person writes on a basis record (dates arrive as `DATE` instants). */
export interface BasisFields {
  purpose: string;
  basis: LawfulBasisKind;
  frameworkId: string | null;
  requirementId: string | null;
  processingActivityId: string | null;
  justification: string | null;
  ownerMembershipId: string | null;
  reviewIntervalDays: number | null;
  reviewLeadDays: number | null;
  lastReviewDate: Date | null;
  nextReviewDate: Date | null;
}

const SELECT = {
  id: true,
  purpose: true,
  basis: true,
  frameworkId: true,
  requirementId: true,
  processingActivityId: true,
  justification: true,
  reviewStatus: true,
  ownerMembershipId: true,
  reviewIntervalDays: true,
  reviewLeadDays: true,
  lastReviewDate: true,
  nextReviewDate: true,
  archivedAt: true,
  version: true,
  framework: { select: { code: true } },
  requirement: { select: { ref: true, title: true } },
  processingActivity: { select: { name: true } },
  owner: { select: { user: { select: { fullName: true } } } },
} as const;

type JoinedRow = {
  framework: { code: string } | null;
  requirement: { ref: string; title: string } | null;
  processingActivity: { name: string } | null;
  owner: { user: { fullName: string } } | null;
} & Omit<
  BasisRecord,
  'frameworkCode' | 'requirementRef' | 'requirementTitle' | 'processingActivityName' | 'ownerName'
>;

/** The flat names the API shows come from the joined rows, never from the client. */
const toRecord = (row: JoinedRow): BasisRecord => {
  const { framework, requirement, processingActivity, owner, ...rest } = row;
  return {
    ...rest,
    frameworkCode: framework?.code ?? null,
    requirementRef: requirement?.ref ?? null,
    requirementTitle: requirement?.title ?? null,
    processingActivityName: processingActivity?.name ?? null,
    ownerName: owner?.user.fullName ?? null,
  };
};

export interface ListOptions {
  limit: number;
  after?: string;
  q?: string;
  basis?: LawfulBasisKind;
  reviewStatus?: LawfulBasisReviewStatus;
  processingActivityId?: string;
  includeArchived: boolean;
}

/**
 * Lawful basis records of the CURRENT organisation, in creation order (ids are UUIDv7). A record is
 * archived, never deleted: the basis a processing relied on two years ago has to stay readable.
 */
@Injectable()
export class LawfulBasisRepository extends TenantRepository {
  constructor(requestContext: RequestContext) {
    super(requestContext);
  }

  async list(tx: Tx, options: ListOptions): Promise<BasisRecord[]> {
    const rows = await tx.lawfulBasisRecord.findMany({
      where: {
        organisationId: this.organisationId,
        ...(options.includeArchived ? {} : { archivedAt: null }),
        ...(options.after ? { id: { gt: options.after } } : {}),
        ...(options.basis ? { basis: options.basis } : {}),
        ...(options.reviewStatus ? { reviewStatus: options.reviewStatus } : {}),
        ...(options.processingActivityId
          ? { processingActivityId: options.processingActivityId }
          : {}),
        ...(options.q
          ? {
              OR: [
                { purpose: { contains: options.q, mode: 'insensitive' as const } },
                { justification: { contains: options.q, mode: 'insensitive' as const } },
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

  findById(tx: Tx, id: string): Promise<BasisRecord | null> {
    return tx.lawfulBasisRecord
      .findFirst({ where: { id, organisationId: this.organisationId }, select: SELECT })
      .then((row) => (row ? toRecord(row) : null));
  }

  create(tx: Tx, data: BasisFields): Promise<BasisRecord> {
    return tx.lawfulBasisRecord
      .create({
        data: { ...data, organisationId: this.organisationId, reviewStatus: 'DRAFT' },
        select: SELECT,
      })
      .then(toRecord);
  }

  async update(
    tx: Tx,
    id: string,
    version: number,
    data: Partial<BasisFields> & {
      reviewStatus?: LawfulBasisReviewStatus;
      archivedAt?: Date | null;
    },
  ): Promise<boolean> {
    const result = await tx.lawfulBasisRecord.updateMany({
      where: { id, version, organisationId: this.organisationId },
      data: { ...data, version: { increment: 1 } },
    });
    return result.count === 1;
  }

  /** Every record of this organisation that is not archived (the coverage metric counts these). */
  async listLive(tx: Tx): Promise<BasisRecord[]> {
    const rows = await tx.lawfulBasisRecord.findMany({
      where: { organisationId: this.organisationId, archivedAt: null },
      orderBy: { id: 'asc' },
      select: SELECT,
    });
    return rows.map(toRecord);
  }

  // ---- evidence links

  async evidenceIdsFor(tx: Tx, recordId: string): Promise<string[]> {
    const rows = await tx.lawfulBasisEvidence.findMany({
      where: { organisationId: this.organisationId, recordId },
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
    recordId: string,
    evidenceId: string,
    byUserId: string,
  ): Promise<boolean> {
    const existing = await tx.lawfulBasisEvidence.findFirst({
      where: { organisationId: this.organisationId, recordId, evidenceId },
      select: { id: true },
    });
    if (existing) return false;
    await tx.lawfulBasisEvidence.create({
      data: { organisationId: this.organisationId, recordId, evidenceId, linkedByUserId: byUserId },
    });
    return true;
  }

  async unlinkEvidence(tx: Tx, recordId: string, evidenceId: string): Promise<boolean> {
    const result = await tx.lawfulBasisEvidence.deleteMany({
      where: { organisationId: this.organisationId, recordId, evidenceId },
    });
    return result.count === 1;
  }

  // ---- the checks that make a record valid in THIS organisation

  async findActiveMember(tx: Tx, membershipId: string): Promise<{ id: string } | null> {
    return tx.membership.findFirst({
      where: { id: membershipId, organisationId: this.organisationId, status: 'ACTIVE' },
      select: { id: true },
    });
  }

  /** A processing activity of this organisation that is not archived. */
  findActivity(tx: Tx, id: string): Promise<{ id: string; archivedAt: Date | null } | null> {
    return tx.ropaActivity.findFirst({
      where: { id, organisationId: this.organisationId },
      select: { id: true, archivedAt: true },
    });
  }

  /** Verified framework content is global: a plain id is enough to exist. */
  findRequirement(tx: Tx, id: string): Promise<{ id: string } | null> {
    return tx.requirement.findFirst({ where: { id }, select: { id: true } });
  }

  findFramework(tx: Tx, id: string): Promise<{ id: string } | null> {
    return tx.framework.findFirst({ where: { id }, select: { id: true } });
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
