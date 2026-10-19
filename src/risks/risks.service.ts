import { HttpStatus, Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { Clock } from '../common/clock.js';
import { AppException, ErrorCode } from '../common/errors/app.exception.js';
import { pageSizeOf, toPage } from '../common/pagination.js';
import type { Tx } from '../database/db-client.js';
import { UnitOfWork } from '../database/unit-of-work.js';
import { addDays, todayIn } from '../domain/remediation/policy.js';
import {
  emptyHeatmap,
  findRiskTransition,
  MATRIX_SIZE,
  nextRiskStatuses,
  OPEN_STATUSES,
  residualWithinInherent,
  riskScoreOf,
  type HeatmapCell,
  type RiskTransition,
} from '../domain/risk/policy.js';
import { RISK_STATUSES, type RiskStatus } from '../domain/risk/policy.js';
import { type RiskLevel } from '../domain/scoring/methodologies.js';
import { REVIEW_LEAD_DAYS, reviewStateOf, toDateOnly, utcDay } from '../domain/registers/review.js';
import { roleHas, type Permission } from '../permissions/catalogue.js';
import { RequestContext } from '../tenancy/request-context.js';
import type {
  AcceptRiskDto,
  ChangeRiskStatusDto,
  CreateRiskDto,
  HeatmapCellDto,
  ListRisksQueryDto,
  RiskAcceptanceDto,
  RiskAcceptancePageDto,
  RiskDetailDto,
  RiskDto,
  RiskHeatmapDto,
  RiskPageDto,
  RiskStatusTransitionDto,
  RiskSummaryDto,
  UpdateRiskDto,
  WithdrawRiskAcceptanceDto,
} from './risks.dto.js';
import {
  RisksRepository,
  type AcceptanceRecord,
  type RiskAggregateRow,
  type RiskFields,
  type RiskRecord,
} from './risks.repository.js';

const notFound = (what: string) =>
  new AppException(ErrorCode.NotFound, HttpStatus.NOT_FOUND, `${what} not found.`);
const versionConflict = () =>
  new AppException(
    ErrorCode.VersionConflict,
    HttpStatus.CONFLICT,
    'This risk was changed by someone else. Reload and try again.',
  );
/** Acceptance is about risk the organisation still carries, so these two statuses cannot be accepted. */
const notAcceptable = (status: RiskStatus) =>
  new AppException(
    ErrorCode.RiskNotAcceptable,
    HttpStatus.CONFLICT,
    status === 'CLOSED'
      ? 'This risk is closed: there is nothing left to accept.'
      : 'This risk is recorded as transferred to someone else. Bring it back to open before accepting it.',
  );
const acceptanceInForce = () =>
  new AppException(
    ErrorCode.RiskAcceptanceInForce,
    HttpStatus.CONFLICT,
    'This risk is already accepted. Withdraw that acceptance before deciding again.',
  );
const noAcceptanceInForce = () =>
  new AppException(
    ErrorCode.Conflict,
    HttpStatus.CONFLICT,
    'This risk has no acceptance in force to withdraw.',
  );
/** The status endpoint only speaks the moves the lifecycle allows. */
const invalidTransition = (from: RiskStatus, allowed: readonly RiskStatus[]) =>
  new AppException(
    ErrorCode.InvalidTransition,
    HttpStatus.CONFLICT,
    allowed.length === 0
      ? `A risk that is ${from} cannot change status.`
      : `A risk that is ${from} can only become ${allowed.join(', ')}.`,
    [{ path: 'toStatus', code: 'invalidTransition', message: `Allowed: ${allowed.join(', ')}.` }],
  );
const forbidden = (what: string) =>
  new AppException(ErrorCode.Forbidden, HttpStatus.FORBIDDEN, `Only an approver can ${what}.`);
const invalid = (path: string, code: string, message: string) =>
  new AppException(
    ErrorCode.ValidationFailed,
    HttpStatus.BAD_REQUEST,
    'Request validation failed.',
    [{ path, code, message }],
  );

/** The caller's role, as the one rule this service needs. */
interface Caller {
  may: (permission: Permission) => boolean;
}

/** The two factor pairs of a risk, as the domain states them. */
interface Factors {
  inherent: { likelihood: number | null; severity: number | null };
  residual: { likelihood: number | null; severity: number | null };
}

/** The score and the band the two factors derive; no pair, no score — and never an invented band. */
const derive = (likelihood: number | null, severity: number | null) => {
  const scored = riskScoreOf(likelihood, severity);
  return { score: scored?.score ?? null, level: scored?.level ?? null };
};

const toAcceptanceDto = (record: AcceptanceRecord): RiskAcceptanceDto => ({
  id: record.id,
  riskId: record.riskId,
  decision: record.decision,
  rationale: record.rationale,
  decidedByUserId: record.decidedByUserId,
  decidedByName: record.decidedByName,
  decidedAt: record.decidedAt.toISOString(),
  expiresOn: toDateOnly(record.expiresOn),
  reviewOn: toDateOnly(record.reviewOn),
});

/** Whole days from the organisation's today to a calendar day; null when there is no day. */
const daysBetween = (today: string, date: string | null): number | null =>
  date === null
    ? null
    : Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);

/**
 * The risk register. A risk carries two factor pairs that a person states; the score and the band beside
 * them are the server's derivation under `risk_matrix_v1`, and the database refuses a row where the four
 * columns disagree. The residual pair may only reduce the inherent pair: controls cannot inflate a risk.
 *
 * Acceptance is not a status a row is edited into — it is a decision written to an append-only ledger, and
 * the status follows the ledger, which is why `ACCEPTED` has no way in on the status endpoint.
 */
@Injectable()
export class RisksService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly risks: RisksRepository,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly requestContext: RequestContext,
  ) {}

  list(query: ListRisksQueryDto): Promise<RiskPageDto> {
    const limit = pageSizeOf(query);
    return this.uow.run(async (tx) => {
      const rows = await this.risks.list(tx, {
        limit,
        ...(query.after ? { after: query.after } : {}),
        ...(query.q ? { q: query.q } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(query.category ? { category: query.category } : {}),
        ...(query.businessUnitId ? { businessUnitId: query.businessUnitId } : {}),
        ...(query.governanceAreaId ? { governanceAreaId: query.governanceAreaId } : {}),
        ...(query.ownerMembershipId ? { ownerMembershipId: query.ownerMembershipId } : {}),
        ...(query.reviewDueBy ? { reviewDueBy: query.reviewDueBy } : {}),
        ...(query.basis ? { basis: query.basis } : {}),
        ...(query.likelihood === undefined ? {} : { likelihood: query.likelihood }),
        ...(query.severity === undefined ? {} : { severity: query.severity }),
        ...(query.includeClosed === false ? { excludeClosed: true } : {}),
      });
      const page = toPage(rows, limit);
      const today = await this.today(tx);
      return {
        items: page.items.map((row) => this.toDto(row, today)),
        nextCursor: page.nextCursor,
      };
    });
  }

  detail(id: string): Promise<RiskDetailDto> {
    return this.uow.run(async (tx) => this.detailIn(tx, await this.mustFind(tx, id)));
  }

  /** A new risk starts OPEN, or IN_TREATMENT when the caller says work on it has already begun. */
  async create(dto: CreateRiskDto): Promise<RiskDto> {
    return this.uow.run(async (tx) => {
      const factors: Factors = {
        inherent: {
          likelihood: dto.inherentLikelihood ?? null,
          severity: dto.inherentSeverity ?? null,
        },
        residual: {
          likelihood: dto.residualLikelihood ?? null,
          severity: dto.residualSeverity ?? null,
        },
      };
      this.assertFactors(factors);
      const inherent = derive(factors.inherent.likelihood, factors.inherent.severity);
      const residual = derive(factors.residual.likelihood, factors.residual.severity);
      const fields: RiskFields = {
        title: dto.title,
        description: dto.description ?? null,
        category: dto.category ?? null,
        governanceAreaId: dto.governanceAreaId ?? null,
        requirementId: dto.requirementId ?? null,
        assessmentItemId: dto.assessmentItemId ?? null,
        businessUnitId: dto.businessUnitId ?? null,
        frameworkId: dto.frameworkId ?? null,
        ownerMembershipId: dto.ownerMembershipId ?? null,
        treatmentPlan: dto.treatmentPlan ?? null,
        inherentLikelihood: factors.inherent.likelihood,
        inherentSeverity: factors.inherent.severity,
        inherentScore: inherent.score,
        inherentLevel: inherent.level,
        residualLikelihood: factors.residual.likelihood,
        residualSeverity: factors.residual.severity,
        residualScore: residual.score,
        residualLevel: residual.level,
        identifiedOn: dto.identifiedOn ? utcDay(dto.identifiedOn) : null,
        reviewByDate: dto.reviewByDate ? utcDay(dto.reviewByDate) : null,
      };
      await this.assertSubjects(tx, fields);
      await this.assertOwner(tx, fields.ownerMembershipId);

      const created = await this.risks.create(tx, fields, dto.status ?? 'OPEN', this.actorUserId());
      await this.audit.record(tx, {
        action: 'risk.created',
        entityType: 'risk',
        entityId: created.id,
        entityLabel: created.title,
        changes: {
          status: created.status,
          inherentScore: created.inherentScore,
          residualScore: created.residualScore,
        },
      });
      return this.toDto(created, await this.today(tx));
    });
  }

  /** The register's text, links and factors. The status has its own endpoint, and so does acceptance. */
  async update(id: string, dto: UpdateRiskDto): Promise<RiskDto> {
    return this.uow.run(async (tx) => {
      const current = await this.mustFind(tx, id);
      if (current.version !== dto.version) throw versionConflict();

      const changes: Partial<RiskFields> = {};
      const audited: Record<string, unknown> = {};
      /**
       * Records one field in the change set and the audit entry. Generic, so each field keeps its own type
       * instead of collapsing into a union. `asText` fields say only that they changed.
       */
      const apply = <K extends keyof RiskFields>(
        key: K,
        next: RiskFields[K] | undefined,
        asText: boolean,
      ) => {
        if (next === undefined || next === current[key]) return;
        changes[key] = next;
        audited[key] = asText ? 'changed' : { from: current[key], to: next };
      };

      apply('title', dto.title, false);
      apply('description', dto.description, true);
      apply('treatmentPlan', dto.treatmentPlan, true);
      apply('category', dto.category, false);
      apply('governanceAreaId', dto.governanceAreaId, false);
      apply('requirementId', dto.requirementId, false);
      apply('assessmentItemId', dto.assessmentItemId, false);
      apply('businessUnitId', dto.businessUnitId, false);
      apply('frameworkId', dto.frameworkId, false);
      apply('ownerMembershipId', dto.ownerMembershipId, false);
      for (const key of ['identifiedOn', 'reviewByDate'] as const) {
        const next = dto[key];
        if (next === undefined) continue;
        const asDate = next ? utcDay(next) : null;
        if (toDateOnly(asDate) !== toDateOnly(current[key])) {
          changes[key] = asDate;
          audited[key] = { from: toDateOnly(current[key]), to: next };
        }
      }

      if (
        dto.inherentLikelihood !== undefined ||
        dto.inherentSeverity !== undefined ||
        dto.residualLikelihood !== undefined ||
        dto.residualSeverity !== undefined
      ) {
        const factors: Factors = {
          inherent: {
            likelihood: dto.inherentLikelihood ?? current.inherentLikelihood,
            severity: dto.inherentSeverity ?? current.inherentSeverity,
          },
          residual: {
            likelihood: dto.residualLikelihood ?? current.residualLikelihood,
            severity: dto.residualSeverity ?? current.residualSeverity,
          },
        };
        this.assertFactors(factors);
        const inherent = derive(factors.inherent.likelihood, factors.inherent.severity);
        const residual = derive(factors.residual.likelihood, factors.residual.severity);
        apply('inherentLikelihood', factors.inherent.likelihood, false);
        apply('inherentSeverity', factors.inherent.severity, false);
        apply('residualLikelihood', factors.residual.likelihood, false);
        apply('residualSeverity', factors.residual.severity, false);
        // the derived pair moves with the factors: it is never sent, and never left behind
        apply('inherentScore', inherent.score, false);
        apply('inherentLevel', inherent.level, false);
        apply('residualScore', residual.score, false);
        apply('residualLevel', residual.level, false);
      }

      if (Object.keys(changes).length === 0) return this.toDto(current, await this.today(tx));

      await this.assertSubjects(tx, changes);
      if ('ownerMembershipId' in changes) {
        await this.assertOwner(tx, changes.ownerMembershipId ?? null);
      }

      if (!(await this.risks.update(tx, id, dto.version, changes))) throw versionConflict();
      await this.audit.record(tx, {
        action: 'risk.updated',
        entityType: 'risk',
        entityId: id,
        entityLabel: changes.title ?? current.title,
        changes: audited,
      });
      // re-read: the joined names and the derived columns are the row's, not this request's
      const fresh = await this.risks.findById(tx, id);
      return this.toDto(fresh ?? current, await this.today(tx));
    });
  }

  /**
   * One step along the lifecycle. An approver's step cannot be taken by an editor, and the steps out of
   * ACCEPTED always carry a reason. Into ACCEPTED there is no step: that is the acceptance decision.
   */
  async changeStatus(id: string, dto: ChangeRiskStatusDto): Promise<RiskDetailDto> {
    return this.uow.run(async (tx) => {
      const current = await this.mustFind(tx, id);
      if (current.version !== dto.version) throw versionConflict();
      if (dto.toStatus === current.status) {
        throw invalid('toStatus', 'unchanged', `This risk is already ${current.status}.`);
      }
      const transition = findRiskTransition(current.status, dto.toStatus);
      if (!transition) {
        throw invalidTransition(
          current.status,
          nextRiskStatuses(current.status).map((step) => step.to),
        );
      }
      this.assertMayTake(transition);
      const reason = dto.reason?.trim() ?? '';
      if (transition.needsReason && reason === '') {
        throw invalid(
          'reason',
          'reasonRequired',
          `Moving a risk from ${transition.from} to ${transition.to} needs a reason: say why.`,
        );
      }

      if (!(await this.risks.update(tx, id, dto.version, { status: dto.toStatus }))) {
        throw versionConflict();
      }
      await this.audit.record(tx, {
        action: 'risk.status_changed',
        entityType: 'risk',
        entityId: id,
        entityLabel: current.title,
        changes: {
          status: { from: transition.from, to: transition.to },
          ...(reason === '' ? {} : { reason }),
        },
      });
      const fresh = await this.mustFind(tx, id);
      return this.detailIn(tx, fresh);
    });
  }

  // ---- the acceptance ledger

  /** The whole ledger of one risk, newest decision first: it is short, so it is never paginated. */
  listAcceptances(id: string): Promise<RiskAcceptancePageDto> {
    return this.uow.run(async (tx) => {
      const record = await this.mustFind(tx, id);
      const rows = await this.risks.listAcceptances(tx, record.id);
      return { items: rows.map(toAcceptanceDto), nextCursor: null };
    });
  }

  /**
   * Accept the risk that is left. The decision goes into the ledger first and the status follows it,
   * because the status is a claim about the ledger and the database checks that the two agree.
   */
  async accept(id: string, dto: AcceptRiskDto): Promise<RiskDetailDto> {
    return this.uow.run(async (tx) => {
      const current = await this.mustFind(tx, id);
      if (current.version !== dto.version) throw versionConflict();
      if (current.status === 'ACCEPTED') throw acceptanceInForce();
      if (!OPEN_STATUSES.includes(current.status)) throw notAcceptable(current.status);
      if (current.inherentLikelihood === null || current.inherentSeverity === null) {
        throw invalid(
          'inherentLikelihood',
          'notScored',
          'Say what is being accepted: a risk with no likelihood and severity has no level to accept.',
        );
      }

      const today = await this.today(tx);
      const expiresOn = dto.expiresOn ?? null;
      if (expiresOn !== null && expiresOn < today) {
        throw invalid(
          'expiresOn',
          'inThePast',
          `An acceptance that expired before today (${today}) accepts nothing.`,
        );
      }
      const reviewOn = dto.reviewOn ?? null;
      if (expiresOn !== null && reviewOn !== null && reviewOn > expiresOn) {
        throw invalid(
          'reviewOn',
          'afterExpiry',
          'The review day has to come on or before the day the acceptance expires.',
        );
      }

      await this.risks.createAcceptance(tx, {
        riskId: current.id,
        decision: 'ACCEPTED',
        rationale: dto.rationale,
        decidedByUserId: this.actorUserId(),
        expiresOn: expiresOn ? utcDay(expiresOn) : null,
        reviewOn: reviewOn ? utcDay(reviewOn) : null,
      });
      if (!(await this.risks.update(tx, id, dto.version, { status: 'ACCEPTED' }))) {
        throw versionConflict();
      }
      await this.audit.record(tx, {
        action: 'risk_acceptance.accepted',
        entityType: 'risk',
        entityId: id,
        entityLabel: current.title,
        changes: {
          status: { from: current.status, to: 'ACCEPTED' },
          rationale: dto.rationale,
          expiresOn,
          reviewOn,
        },
      });
      // the ledger is re-read inside this transaction, so it already holds the decision just written
      return this.detailIn(tx, await this.mustFind(tx, id));
    });
  }

  /**
   * Stop accepting it: the ledger gets the withdrawal and the risk moves to an open status. Which of the
   * two is the caller's decision — this service never guesses where a risk went after the acceptance ended.
   */
  async withdrawAcceptance(id: string, dto: WithdrawRiskAcceptanceDto): Promise<RiskDetailDto> {
    return this.uow.run(async (tx) => {
      const current = await this.mustFind(tx, id);
      if (current.version !== dto.version) throw versionConflict();
      if (current.status !== 'ACCEPTED') throw noAcceptanceInForce();

      const transition = findRiskTransition('ACCEPTED', dto.toStatus);
      if (!transition) throw invalidTransition('ACCEPTED', ['OPEN', 'IN_TREATMENT']);
      this.assertMayTake(transition);

      await this.risks.createAcceptance(tx, {
        riskId: current.id,
        decision: 'WITHDRAWN',
        rationale: dto.rationale,
        decidedByUserId: this.actorUserId(),
        expiresOn: null,
        reviewOn: null,
      });
      if (!(await this.risks.update(tx, id, dto.version, { status: dto.toStatus }))) {
        throw versionConflict();
      }
      await this.audit.record(tx, {
        action: 'risk_acceptance.withdrawn',
        entityType: 'risk',
        entityId: id,
        entityLabel: current.title,
        changes: { status: { from: 'ACCEPTED', to: dto.toStatus }, rationale: dto.rationale },
      });
      return this.detailIn(tx, await this.mustFind(tx, id));
    });
  }

  // ---- the register's own numbers

  async summary(): Promise<RiskSummaryDto> {
    return this.uow.run(async (tx) => {
      const [rows, live, today] = await Promise.all([
        this.risks.aggregateRows(tx),
        this.risks.liveAcceptances(tx),
        this.today(tx),
      ]);
      // a CLOSED risk is history rather than exposure, so the level and review counts skip it
      const carried = rows.filter((row) => row.status !== 'CLOSED');
      const countBy = (pick: (row: RiskAggregateRow) => boolean) =>
        rows.filter((row) => pick(row)).length;

      const byStatus = Object.fromEntries(
        RISK_STATUSES.map((status) => [status, countBy((row) => row.status === status)]),
      ) as RiskSummaryDto['byStatus'];

      const levelCount = (pick: (row: RiskAggregateRow) => RiskLevel | null) => {
        const counts = { LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: 0, NOT_SCORED: 0 } as Record<
          RiskLevel | 'NOT_SCORED',
          number
        >;
        for (const row of carried) {
          counts[pick(row) ?? 'NOT_SCORED'] += 1;
        }
        return counts;
      };

      const reviews = { overdue: 0, dueSoon: 0, ok: 0, notScheduled: 0 };
      for (const row of carried) {
        const state = reviewStateOf(toDateOnly(row.reviewByDate), today, REVIEW_LEAD_DAYS);
        if (state === 'not_reviewed') reviews.notScheduled += 1;
        else if (state === 'due_soon') reviews.dueSoon += 1;
        else reviews[state] += 1;
      }

      const horizon = addDays(today, REVIEW_LEAD_DAYS);
      return {
        availability: rows.length === 0 ? 'no_records' : 'ok',
        asOf: today,
        total: carried.length,
        byStatus,
        open: carried.filter((row) => OPEN_STATUSES.includes(row.status)).length,
        byResidualLevel: levelCount((row) => row.residualLevel),
        byInherentLevel: levelCount((row) => row.inherentLevel),
        reviews,
        acceptancesExpiring: live.filter((row) => {
          const day = toDateOnly(row.expiresOn);
          return day !== null && day <= horizon;
        }).length,
      };
    });
  }

  /** The five by five grid. A risk with an incomplete pair is counted as unscored, never placed on the grid. */
  async heatmap(basis: 'residual' | 'inherent'): Promise<RiskHeatmapDto> {
    return this.uow.run(async (tx) => {
      const [rows, today] = await Promise.all([this.risks.aggregateRows(tx), this.today(tx)]);
      const carried = rows.filter((row) => row.status !== 'CLOSED');
      const cells: HeatmapCell[] = emptyHeatmap();
      let unscored = 0;
      for (const row of carried) {
        const likelihood = basis === 'inherent' ? row.inherentLikelihood : row.residualLikelihood;
        const severity = basis === 'inherent' ? row.inherentSeverity : row.residualSeverity;
        const cell =
          likelihood !== null &&
          severity !== null &&
          likelihood >= 1 &&
          likelihood <= MATRIX_SIZE &&
          severity >= 1 &&
          severity <= MATRIX_SIZE
            ? cells.find(
                (candidate) =>
                  candidate.likelihood === likelihood && candidate.severity === severity,
              )
            : undefined;
        if (cell) cell.count += 1;
        else unscored += 1;
      }
      return {
        basis,
        availability: carried.length === 0 ? 'no_records' : 'ok',
        asOf: today,
        cells: cells.map<HeatmapCellDto>(({ likelihood, severity, count, level }) => ({
          likelihood,
          severity,
          count,
          level,
        })),
        unscored,
      };
    });
  }

  // ---- the checks, all of them here and none of them in the controller

  private caller(): Caller {
    const { role } = this.requestContext.get();
    return { may: (permission) => role !== undefined && roleHas(role, permission) };
  }

  private assertMayTake(transition: RiskTransition): void {
    if (transition.by === 'approve') {
      if (!this.caller().may('governance.approve')) {
        throw forbidden(`move a risk from ${transition.from} to ${transition.to}`);
      }
      return;
    }
    if (!this.caller().may('governance.edit')) {
      throw new AppException(
        ErrorCode.Forbidden,
        HttpStatus.FORBIDDEN,
        'Only someone who may edit the risk register can take this step.',
      );
    }
  }

  /** The steps THIS caller can take now, so the UI never offers a forbidden one. */
  private allowedTransitions(status: RiskStatus): RiskStatusTransitionDto[] {
    const caller = this.caller();
    return nextRiskStatuses(status)
      .filter((step) =>
        step.by === 'approve' ? caller.may('governance.approve') : caller.may('governance.edit'),
      )
      .map(({ to, by, needsReason }) => ({ toStatus: to, by, needsReason }));
  }

  private toDto(record: RiskRecord, today: string) {
    const reviewByDate = toDateOnly(record.reviewByDate);
    return {
      id: record.id,
      title: record.title,
      description: record.description,
      category: record.category,
      status: record.status,
      governanceAreaId: record.governanceAreaId,
      governanceAreaName: record.governanceAreaName,
      requirementId: record.requirementId,
      requirementRef: record.requirementRef,
      requirementTitle: record.requirementTitle,
      assessmentItemId: record.assessmentItemId,
      businessUnitId: record.businessUnitId,
      businessUnitName: record.businessUnitName,
      frameworkId: record.frameworkId,
      frameworkCode: record.frameworkCode,
      ownerMembershipId: record.ownerMembershipId,
      ownerName: record.ownerName,
      treatmentPlan: record.treatmentPlan,
      inherent: {
        likelihood: record.inherentLikelihood,
        severity: record.inherentSeverity,
        score: record.inherentScore,
        level: record.inherentLevel,
      },
      residual: {
        likelihood: record.residualLikelihood,
        severity: record.residualSeverity,
        score: record.residualScore,
        level: record.residualLevel,
      },
      methodologyId: record.methodologyId,
      methodologyVersion: record.methodologyVersion,
      identifiedOn: toDateOnly(record.identifiedOn),
      reviewByDate,
      reviewState: reviewStateOf(reviewByDate, today, REVIEW_LEAD_DAYS),
      daysRemaining: daysBetween(today, reviewByDate),
      createdByUserId: record.createdByUserId,
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
      version: record.version,
      allowedTransitions: this.allowedTransitions(record.status),
    };
  }

  private async detailIn(tx: Tx, record: RiskRecord): Promise<RiskDetailDto> {
    const [acceptances, today] = await Promise.all([
      this.risks.listAcceptances(tx, record.id),
      this.today(tx),
    ]);
    return {
      ...this.toDto(record, today),
      acceptances: acceptances.map(toAcceptanceDto),
      acceptanceInForce: acceptances[0]?.decision === 'ACCEPTED',
    };
  }

  private async mustFind(tx: Tx, id: string): Promise<RiskRecord> {
    const risk = await this.risks.findById(tx, id);
    if (!risk) throw notFound('Risk');
    return risk;
  }

  /** Today in the organisation's own zone: a review or expiry date means nothing in the server's zone. */
  private async today(tx: Tx): Promise<string> {
    return todayIn(await this.risks.timezone(tx), this.clock.now());
  }

  /**
   * A half-stated pair is allowed and simply derives to no score; a residual pair that exceeds the
   * inherent one, or stands without an inherent pair, is not — controls cannot inflate a risk.
   */
  private assertFactors(factors: Factors): void {
    if (!residualWithinInherent(factors.inherent, factors.residual)) {
      throw invalid(
        'residualLikelihood',
        'residualAboveInherent',
        'Residual risk is what is left after the controls: state both residual factors, keep each at or below its inherent one, and state the inherent pair first.',
      );
    }
  }

  private async assertSubjects(tx: Tx, fields: Partial<RiskFields>): Promise<void> {
    if (fields.governanceAreaId && !(await this.risks.findArea(tx, fields.governanceAreaId))) {
      throw invalid(
        'governanceAreaId',
        'unknownGovernanceArea',
        'The governance area does not exist in this organisation.',
      );
    }
    if (fields.businessUnitId && !(await this.risks.findBusinessUnit(tx, fields.businessUnitId))) {
      throw invalid(
        'businessUnitId',
        'unknownBusinessUnit',
        'The business unit does not exist in this organisation.',
      );
    }
    if (fields.assessmentItemId && !(await this.risks.findItem(tx, fields.assessmentItemId))) {
      throw invalid(
        'assessmentItemId',
        'unknownAssessmentItem',
        'The assessment item does not exist in this organisation.',
      );
    }
    if (fields.requirementId && !(await this.risks.findRequirement(tx, fields.requirementId))) {
      throw invalid('requirementId', 'unknownRequirement', 'The requirement does not exist.');
    }
    if (fields.frameworkId && !(await this.risks.findFramework(tx, fields.frameworkId))) {
      throw invalid('frameworkId', 'unknownFramework', 'The framework does not exist.');
    }
  }

  private async assertOwner(tx: Tx, ownerMembershipId: string | null): Promise<void> {
    if (!ownerMembershipId) return;
    if (!(await this.risks.findActiveMember(tx, ownerMembershipId))) {
      throw invalid(
        'ownerMembershipId',
        'notAnActiveMember',
        'The owner must be an active member of this organisation.',
      );
    }
  }

  /** The person the decision is attributed to; a risk and its ledger are always attributed. */
  private actorUserId(): string {
    const actorUserId = this.requestContext.actorUserId;
    if (!actorUserId) {
      throw new AppException(
        ErrorCode.InternalError,
        HttpStatus.INTERNAL_SERVER_ERROR,
        'No signed-in user for this request.',
      );
    }
    return actorUserId;
  }
}
