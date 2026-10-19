import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException, ErrorCode } from '../common/errors/app.exception.js';
import type { Tx } from '../database/db-client.js';
import { TenantRepository } from '../database/tenant-repository.js';
import type { AcceptanceDecision, RiskCategory, RiskStatus } from '../domain/risk/policy.js';
import type { RiskLevel } from '../domain/scoring/methodologies.js';
import { RequestContext } from '../tenancy/request-context.js';

/** A risk with the names of what it points at, as the API shows it. */
export interface RiskRecord {
  id: string;
  title: string;
  description: string | null;
  category: RiskCategory | null;
  status: RiskStatus;
  governanceAreaId: string | null;
  governanceAreaName: string | null;
  requirementId: string | null;
  requirementRef: string | null;
  requirementTitle: string | null;
  assessmentItemId: string | null;
  businessUnitId: string | null;
  businessUnitName: string | null;
  frameworkId: string | null;
  frameworkCode: string | null;
  ownerMembershipId: string | null;
  ownerName: string | null;
  treatmentPlan: string | null;
  inherentLikelihood: number | null;
  inherentSeverity: number | null;
  inherentScore: number | null;
  inherentLevel: RiskLevel | null;
  residualLikelihood: number | null;
  residualSeverity: number | null;
  residualScore: number | null;
  residualLevel: RiskLevel | null;
  /** Which methodology decided the band: a row records what scored it, so a later change cannot rewrite it. */
  methodologyId: string;
  methodologyVersion: number;
  /** DATE columns: UTC-midnight Dates whose UTC day is the calendar day. */
  identifiedOn: Date | null;
  reviewByDate: Date | null;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}

/**
 * The columns a risk row carries. The four factor columns are what a person states and the score and level
 * beside them are the server's derivation of them; neither is ever taken from the client.
 */
export interface RiskFields {
  title: string;
  description: string | null;
  category: RiskCategory | null;
  governanceAreaId: string | null;
  requirementId: string | null;
  assessmentItemId: string | null;
  businessUnitId: string | null;
  frameworkId: string | null;
  ownerMembershipId: string | null;
  treatmentPlan: string | null;
  inherentLikelihood: number | null;
  inherentSeverity: number | null;
  inherentScore: number | null;
  inherentLevel: RiskLevel | null;
  residualLikelihood: number | null;
  residualSeverity: number | null;
  residualScore: number | null;
  residualLevel: RiskLevel | null;
  identifiedOn: Date | null;
  reviewByDate: Date | null;
}

/** One row of the acceptance ledger: a decision to accept, or to stop accepting. */
export interface AcceptanceRecord {
  id: string;
  riskId: string;
  decision: AcceptanceDecision;
  rationale: string;
  decidedByUserId: string;
  decidedByName: string | null;
  decidedAt: Date;
  expiresOn: Date | null;
  reviewOn: Date | null;
}

/** The columns the summary and the heatmap are counted from. */
export interface RiskAggregateRow {
  id: string;
  status: RiskStatus;
  inherentLevel: RiskLevel | null;
  residualLevel: RiskLevel | null;
  inherentLikelihood: number | null;
  inherentSeverity: number | null;
  residualLikelihood: number | null;
  residualSeverity: number | null;
  reviewByDate: Date | null;
}

const SELECT = {
  id: true,
  title: true,
  description: true,
  category: true,
  status: true,
  governanceAreaId: true,
  requirementId: true,
  assessmentItemId: true,
  businessUnitId: true,
  frameworkId: true,
  ownerMembershipId: true,
  treatmentPlan: true,
  inherentLikelihood: true,
  inherentSeverity: true,
  inherentScore: true,
  inherentLevel: true,
  residualLikelihood: true,
  residualSeverity: true,
  residualScore: true,
  residualLevel: true,
  methodologyId: true,
  methodologyVersion: true,
  identifiedOn: true,
  reviewByDate: true,
  createdByUserId: true,
  createdAt: true,
  updatedAt: true,
  version: true,
  governanceArea: { select: { name: true } },
  requirement: { select: { ref: true, title: true } },
  businessUnit: { select: { name: true } },
  framework: { select: { code: true } },
  owner: { select: { user: { select: { fullName: true } } } },
} as const;

type RiskRow = {
  governanceArea: { name: string } | null;
  requirement: { ref: string; title: string } | null;
  businessUnit: { name: string } | null;
  framework: { code: string } | null;
  owner: { user: { fullName: string } } | null;
} & Omit<
  RiskRecord,
  | 'governanceAreaName'
  | 'requirementRef'
  | 'requirementTitle'
  | 'businessUnitName'
  | 'frameworkCode'
  | 'ownerName'
>;

/** The flat names the API shows come from the joined rows, never from the client. */
const toRecord = (row: RiskRow): RiskRecord => {
  const { governanceArea, requirement, businessUnit, framework, owner, ...rest } = row;
  return {
    ...rest,
    governanceAreaName: governanceArea?.name ?? null,
    requirementRef: requirement?.ref ?? null,
    requirementTitle: requirement?.title ?? null,
    businessUnitName: businessUnit?.name ?? null,
    frameworkCode: framework?.code ?? null,
    ownerName: owner?.user.fullName ?? null,
  };
};

const ACCEPTANCE_SELECT = {
  id: true,
  riskId: true,
  decision: true,
  rationale: true,
  decidedByUserId: true,
  decidedAt: true,
  expiresOn: true,
  reviewOn: true,
  decidedBy: { select: { fullName: true } },
} as const;

type AcceptanceRow = { decidedBy: { fullName: string } } & Omit<AcceptanceRecord, 'decidedByName'>;

const toAcceptance = (row: AcceptanceRow): AcceptanceRecord => {
  const { decidedBy, ...rest } = row;
  return { ...rest, decidedByName: decidedBy.fullName };
};

const AGGREGATE_SELECT = {
  id: true,
  status: true,
  inherentLevel: true,
  residualLevel: true,
  inherentLikelihood: true,
  inherentSeverity: true,
  residualLikelihood: true,
  residualSeverity: true,
  reviewByDate: true,
} as const;

/** The factor columns of the basis the caller named: a heat-map cell and its drill-down read one pair. */
const factorWhere = (
  basis: 'residual' | 'inherent' | undefined,
  likelihood: number | undefined,
  severity: number | undefined,
) =>
  likelihood === undefined && severity === undefined
    ? {}
    : basis === 'inherent'
      ? {
          ...(likelihood === undefined ? {} : { inherentLikelihood: likelihood }),
          ...(severity === undefined ? {} : { inherentSeverity: severity }),
        }
      : {
          ...(likelihood === undefined ? {} : { residualLikelihood: likelihood }),
          ...(severity === undefined ? {} : { residualSeverity: severity }),
        };

export interface ListOptions {
  limit: number;
  after?: string;
  q?: string;
  status?: RiskStatus;
  category?: RiskCategory;
  businessUnitId?: string;
  governanceAreaId?: string;
  ownerMembershipId?: string;
  /** Only risks whose review is due on or before this calendar day (`YYYY-MM-DD`). */
  reviewDueBy?: string;
  /** Which pair the two factor filters read. `residual` matches the heat map's own default. */
  basis?: 'residual' | 'inherent';
  /** Only risks at this likelihood on that basis (a heat-map cell). */
  likelihood?: number;
  /** Only risks at this severity on that basis (the other half of the cell). */
  severity?: number;
  /** Hide CLOSED risks: a register view that only wants what is still carried. */
  excludeClosed?: boolean;
}

/**
 * The risk register of the CURRENT organisation, in creation order (ids are UUIDv7). The stored score and
 * level are the server's derivation and the database ties them to the two factors, so nothing here can
 * write a level that disagrees with its own arithmetic.
 */
@Injectable()
export class RisksRepository extends TenantRepository {
  constructor(requestContext: RequestContext) {
    super(requestContext);
  }

  async list(tx: Tx, options: ListOptions): Promise<RiskRecord[]> {
    const rows = await tx.risk.findMany({
      where: {
        organisationId: this.organisationId,
        ...(options.status
          ? { status: options.status }
          : options.excludeClosed
            ? { status: { not: 'CLOSED' as const } }
            : {}),
        ...(options.category ? { category: options.category } : {}),
        ...(options.businessUnitId ? { businessUnitId: options.businessUnitId } : {}),
        ...(options.governanceAreaId ? { governanceAreaId: options.governanceAreaId } : {}),
        ...(options.ownerMembershipId ? { ownerMembershipId: options.ownerMembershipId } : {}),
        ...(options.reviewDueBy
          ? { reviewByDate: { lte: new Date(`${options.reviewDueBy}T00:00:00.000Z`) } }
          : {}),
        ...factorWhere(options.basis, options.likelihood, options.severity),
        ...(options.after ? { id: { gt: options.after } } : {}),
        ...(options.q
          ? {
              OR: [
                { title: { contains: options.q, mode: 'insensitive' as const } },
                { description: { contains: options.q, mode: 'insensitive' as const } },
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

  findById(tx: Tx, id: string): Promise<RiskRecord | null> {
    return tx.risk
      .findFirst({ where: { id, organisationId: this.organisationId }, select: SELECT })
      .then((row) => (row ? toRecord(row) : null));
  }

  create(
    tx: Tx,
    data: RiskFields,
    status: RiskStatus,
    createdByUserId: string,
  ): Promise<RiskRecord> {
    return tx.risk
      .create({
        data: { ...data, status, organisationId: this.organisationId, createdByUserId },
        select: SELECT,
      })
      .then(toRecord);
  }

  async update(
    tx: Tx,
    id: string,
    version: number,
    data: Partial<RiskFields> & { status?: RiskStatus },
  ): Promise<boolean> {
    const result = await tx.risk.updateMany({
      where: { id, version, organisationId: this.organisationId },
      data: { ...data, version: { increment: 1 } },
    });
    return result.count === 1;
  }

  /** Every risk's counting columns: the summary and the heatmap are decided over these, in one read. */
  aggregateRows(tx: Tx): Promise<RiskAggregateRow[]> {
    return tx.risk.findMany({
      where: { organisationId: this.organisationId },
      orderBy: { id: 'asc' },
      select: AGGREGATE_SELECT,
    });
  }

  // ---- the acceptance ledger (append-only)

  async listAcceptances(tx: Tx, riskId: string): Promise<AcceptanceRecord[]> {
    const rows = await tx.riskAcceptance.findMany({
      where: { organisationId: this.organisationId, riskId },
      // newest decision first: the head of the ledger is the decision in force
      orderBy: { decidedAt: 'desc' },
      select: ACCEPTANCE_SELECT,
    });
    return rows.map(toAcceptance);
  }

  /** The decision in force: the newest row for this risk, or null when it was never accepted. */
  findNewestAcceptance(tx: Tx, riskId: string): Promise<AcceptanceRecord | null> {
    return tx.riskAcceptance
      .findFirst({
        where: { organisationId: this.organisationId, riskId },
        orderBy: { decidedAt: 'desc' },
        select: ACCEPTANCE_SELECT,
      })
      .then((row) => (row ? toAcceptance(row) : null));
  }

  /**
   * The acceptances in force across the register: an ACCEPTED decision on a risk that is still ACCEPTED.
   * The database keeps those two in step, so this pair is exactly the decisions that currently bind.
   */
  async liveAcceptances(tx: Tx): Promise<AcceptanceRecord[]> {
    const rows = await tx.riskAcceptance.findMany({
      where: {
        organisationId: this.organisationId,
        decision: 'ACCEPTED',
        risk: { organisationId: this.organisationId, status: 'ACCEPTED' },
      },
      orderBy: { id: 'asc' },
      select: ACCEPTANCE_SELECT,
    });
    return rows.map(toAcceptance);
  }

  createAcceptance(
    tx: Tx,
    data: {
      riskId: string;
      decision: AcceptanceDecision;
      rationale: string;
      decidedByUserId: string;
      expiresOn: Date | null;
      reviewOn: Date | null;
    },
  ): Promise<AcceptanceRecord> {
    return tx.riskAcceptance
      .create({
        data: { ...data, organisationId: this.organisationId },
        select: ACCEPTANCE_SELECT,
      })
      .then(toAcceptance);
  }

  // ---- the checks that make a reference valid in THIS organisation

  findActiveMember(tx: Tx, membershipId: string): Promise<{ id: string } | null> {
    return tx.membership.findFirst({
      where: { id: membershipId, organisationId: this.organisationId, status: 'ACTIVE' },
      select: { id: true },
    });
  }

  findArea(tx: Tx, id: string): Promise<{ id: string } | null> {
    return tx.governanceArea.findFirst({
      where: { id, organisationId: this.organisationId },
      select: { id: true },
    });
  }

  findBusinessUnit(tx: Tx, id: string): Promise<{ id: string } | null> {
    return tx.businessUnit.findFirst({
      where: { id, organisationId: this.organisationId },
      select: { id: true },
    });
  }

  /** An assessment item of this organisation, with the ratings it recorded (a risk may cite them). */
  findItem(tx: Tx, id: string): Promise<{ id: string } | null> {
    return tx.assessmentItem.findFirst({
      where: { id, organisationId: this.organisationId },
      select: { id: true },
    });
  }

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
