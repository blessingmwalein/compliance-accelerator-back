import { HttpStatus, Injectable } from '@nestjs/common';
import type { AuditAction } from '../audit/audit-actions.js';
import { AuditService } from '../audit/audit.service.js';
import { Clock } from '../common/clock.js';
import { AppException, ErrorCode, type FieldError } from '../common/errors/app.exception.js';
import { pageSizeOf, toPage } from '../common/pagination.js';
import type { Tx } from '../database/db-client.js';
import { UnitOfWork } from '../database/unit-of-work.js';
import { scoreItem, summarise } from '../domain/scoring/scoring.js';
import { SCORING_DISCLAIMER, ScoringService } from '../scoring/scoring.service.js';
import { RequestContext } from '../tenancy/request-context.js';
import { AssessmentItemsRepository } from './assessment-items.repository.js';
import { bandsOf, methodologyOf } from './assessment-snapshot.js';
import {
  AssessmentsRepository,
  type AssessmentChanges,
  type AssessmentRecord,
} from './assessments.repository.js';
import type {
  ApproveAssessmentDto,
  AssessmentDto,
  AssessmentHistoryDto,
  AssessmentHistoryEntryDto,
  AssessmentListQueryDto,
  AssessmentPageDto,
  AssessmentStatusValue,
  AssessmentSummaryDto,
  AssessmentVersionDto,
  CreateAssessmentDto,
  ItemFilterQueryDto,
  ReturnAssessmentDto,
  SubmitAssessmentDto,
  UpdateAssessmentDto,
} from './assessments.dto.js';

/** Which states may be revised (a DRAFT is already the working copy, a review is in progress). */
const REVISABLE: readonly AssessmentStatusValue[] = ['APPROVED', 'SUPERSEDED'];

const notFound = () =>
  new AppException(ErrorCode.NotFound, HttpStatus.NOT_FOUND, 'Assessment not found.');

const notEditable = () =>
  new AppException(
    ErrorCode.AssessmentNotEditable,
    HttpStatus.CONFLICT,
    'Only a draft assessment can be changed. Approved cycles are kept as they were signed off.',
  );

const versionConflict = () =>
  new AppException(
    ErrorCode.VersionConflict,
    HttpStatus.CONFLICT,
    'This assessment was changed by someone else. Reload and try again.',
  );

const emptyAssessment = () =>
  new AppException(
    ErrorCode.AssessmentEmpty,
    HttpStatus.UNPROCESSABLE_ENTITY,
    'Add at least one item before sending an assessment for review.',
  );

const notInReview = () =>
  new AppException(
    ErrorCode.AssessmentNotEditable,
    HttpStatus.CONFLICT,
    'Only an assessment that was submitted for review can be approved or returned.',
  );

const invalid = (errors: FieldError[]) =>
  new AppException(
    ErrorCode.ValidationFailed,
    HttpStatus.BAD_REQUEST,
    'Request validation failed.',
    errors,
  );

const needActor = (actorUserId: string | undefined): string => {
  if (!actorUserId) throw new Error('Assessment work needs a signed-in actor');
  return actorUserId;
};

const isoOf = (value: Date | null): string | null => value?.toISOString() ?? null;

const toDto = (record: AssessmentRecord): AssessmentDto => {
  // The row names its methodology; this build knows what each name means. An unknown name would be a bug, and
  // is shown as it was stored rather than given words it never had.
  const methodology = methodologyOf(record.methodologyId);
  return {
    id: record.id,
    title: record.title,
    description: record.description,
    status: record.status,
    methodology: {
      id: record.methodologyId,
      version: record.methodologyVersion,
      label: methodology?.label ?? record.methodologyId,
      formula: methodology?.formula ?? record.methodologyId,
    },
    exposureBands: bandsOf(record.exposureBands),
    createdByUserId: record.createdByUserId,
    submittedAt: isoOf(record.submittedAt),
    submittedByUserId: record.submittedByUserId,
    approvedAt: isoOf(record.approvedAt),
    approvedByUserId: record.approvedByUserId,
    reviewComment: record.reviewComment,
    revisesAssessmentId: record.revisesAssessmentId,
    itemCount: record.itemCount,
    version: record.version,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
};

const toEntry = (record: AssessmentRecord, currentId: string): AssessmentHistoryEntryDto => ({
  id: record.id,
  title: record.title,
  status: record.status,
  submittedAt: isoOf(record.submittedAt),
  approvedAt: isoOf(record.approvedAt),
  approvedByUserId: record.approvedByUserId,
  reviewComment: record.reviewComment,
  current: record.id === currentId,
});

/**
 * Assessment cycles: create, rate, submit, approve — and the revision line that keeps every signed-off cycle
 * readable forever (AC-GOV-04).
 *
 * A cycle freezes the exposure bands it was scored with, so changing the policy later cannot rewrite history.
 * APPROVED cycles are immutable: more work happens in a NEW cycle that revises it, and approving that one marks
 * the old cycle SUPERSEDED rather than changing it.
 */
@Injectable()
export class AssessmentsService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly assessments: AssessmentsRepository,
    private readonly items: AssessmentItemsRepository,
    private readonly scoring: ScoringService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly requestContext: RequestContext,
  ) {}

  async list(query: AssessmentListQueryDto): Promise<AssessmentPageDto> {
    const limit = pageSizeOf(query);
    const rows = await this.uow.run((tx) =>
      this.assessments.list(tx, {
        limit,
        ...(query.after ? { after: query.after } : {}),
        ...(query.status ? { status: query.status } : {}),
      }),
    );
    const page = toPage(rows, limit);
    return { items: page.items.map(toDto), nextCursor: page.nextCursor };
  }

  async get(id: string): Promise<AssessmentDto> {
    return this.uow.run(async (tx) => {
      const record = await this.assessments.findById(tx, id);
      if (!record) throw notFound();
      return toDto(record);
    });
  }

  /** A new cycle starts as a DRAFT with the bands currently in force, frozen into the row. */
  async create(dto: CreateAssessmentDto): Promise<AssessmentDto> {
    const actorUserId = needActor(this.requestContext.actorUserId);
    return this.uow.run(async (tx) => {
      if (dto.revisesAssessmentId) await this.revisableTarget(tx, dto.revisesAssessmentId);
      const bands = [...(await this.scoring.bandsInForce(tx))];
      const created = await this.assessments.create(tx, {
        title: dto.title,
        description: dto.description ?? null,
        methodologyId: 'exposure_v1',
        methodologyVersion: 1,
        exposureBands: bands,
        createdByUserId: actorUserId,
        revisesAssessmentId: dto.revisesAssessmentId ?? null,
      });
      await this.audit.record(tx, {
        action: 'assessment.created',
        entityType: 'assessment',
        entityId: created.id,
        entityLabel: created.title,
        changes: { methodologyId: created.methodologyId, bandCount: bands.length },
      });
      return toDto(created);
    });
  }

  update(id: string, dto: UpdateAssessmentDto): Promise<AssessmentDto> {
    return this.uow.run(async (tx) =>
      this.change(tx, id, dto.version, (current) => {
        if (current.status !== 'DRAFT') throw notEditable();
        const changes: AssessmentChanges = {};
        const audited: Record<string, unknown> = {};
        if (dto.title !== undefined && dto.title !== current.title) {
          changes.title = dto.title;
          audited.title = { from: current.title, to: dto.title };
        }
        if (dto.description !== undefined && dto.description !== current.description) {
          changes.description = dto.description;
          audited.description = 'changed';
        }
        return { changes, audited };
      }),
    );
  }

  /**
   * Discards a DRAFT cycle with its items and evidence links. The files themselves stay (another item may use
   * one, and the storage trail is not the assessment's to delete). A cycle with work already raised against it
   * cannot be thrown away: those tasks would lose what they are about.
   */
  remove(id: string, version: number): Promise<void> {
    return this.uow.run(async (tx) => {
      const current = await this.mustFind(tx, id);
      if (current.status !== 'DRAFT') throw notEditable();
      if (current.version !== version) throw versionConflict();
      if (current.itemCount > 0 && (await this.items.taskReferenceCount(tx, id)) > 0) {
        throw new AppException(
          ErrorCode.Conflict,
          HttpStatus.CONFLICT,
          'Remediation tasks were raised from this assessment, so it cannot be deleted. Keep it as history instead.',
        );
      }
      const removedItems = await this.items.removeAllOf(tx, id);
      if ((await this.assessments.remove(tx, id)).count !== 1) throw notFound();
      await this.audit.record(tx, {
        action: 'assessment.deleted',
        entityType: 'assessment',
        entityId: id,
        entityLabel: current.title,
        changes: { removedItems },
      });
    });
  }

  /** DRAFT to IN_REVIEW. An assessment with no items is not a result and cannot be submitted. */
  submit(id: string, dto: SubmitAssessmentDto): Promise<AssessmentDto> {
    const actorUserId = needActor(this.requestContext.actorUserId);
    return this.uow.run(async (tx) => {
      const current = await this.mustFind(tx, id);
      if (current.status !== 'DRAFT') throw notEditable();
      if (current.version !== dto.version) throw versionConflict();
      if ((await this.items.count(tx, id)) === 0) throw emptyAssessment();
      const submittedAt = this.clock.now();
      return this.write(
        tx,
        current,
        dto.version,
        {
          status: 'IN_REVIEW',
          submittedAt,
          submittedByUserId: actorUserId,
          reviewComment: dto.comment ?? null,
        },
        'assessment.submitted',
        { itemCount: current.itemCount },
      );
    });
  }

  /**
   * IN_REVIEW to APPROVED: the sign-off is stored on the row (who, when, with what comment) and the cycle stops
   * changing. If this cycle revises an approved one, that one becomes SUPERSEDED in the same transaction.
   */
  approve(id: string, dto: ApproveAssessmentDto): Promise<AssessmentDto> {
    const actorUserId = needActor(this.requestContext.actorUserId);
    return this.uow.run(async (tx) => {
      const current = await this.mustFind(tx, id);
      if (current.status !== 'IN_REVIEW') throw notInReview();
      if (current.version !== dto.version) throw versionConflict();
      const approvedAt = this.clock.now();
      const approved = await this.write(
        tx,
        current,
        dto.version,
        {
          status: 'APPROVED',
          approvedAt,
          approvedByUserId: actorUserId,
          reviewComment: dto.comment ?? current.reviewComment,
        },
        'assessment.approved',
        { itemCount: current.itemCount },
      );
      if (current.revisesAssessmentId) {
        await this.supersedeRevised(tx, current.revisesAssessmentId, current.id);
      }
      return approved;
    });
  }

  /** Back to DRAFT for more work, with the reason the reviewer gave. */
  returnForReview(id: string, dto: ReturnAssessmentDto): Promise<AssessmentDto> {
    return this.uow.run(async (tx) => {
      const current = await this.mustFind(tx, id);
      if (current.status !== 'IN_REVIEW') throw notInReview();
      if (current.version !== dto.version) throw versionConflict();
      return this.write(
        tx,
        current,
        dto.version,
        { status: 'DRAFT', submittedAt: null, submittedByUserId: null, reviewComment: dto.comment },
        'assessment.returned',
        { commentLength: dto.comment.length },
      );
    });
  }

  /**
   * Starts the next cycle over an approved one: a new DRAFT with the same items and the same ratings, so the
   * reviewer's numbers carry over and this cycle can be re-rated from there. Nothing is copied but the scores;
   * the triage answers and the evidence links belong to the cycle that made them.
   */
  async revise(id: string, dto: AssessmentVersionDto): Promise<AssessmentDto> {
    const actorUserId = needActor(this.requestContext.actorUserId);
    return this.uow.run(async (tx) => {
      const source = await this.mustFind(tx, id);
      if (!REVISABLE.includes(source.status)) throw notEditable();
      if (source.version !== dto.version) throw versionConflict();

      const bands = [...(await this.scoring.bandsInForce(tx))];
      const created = await this.assessments.create(tx, {
        title: source.title,
        description: source.description,
        methodologyId: source.methodologyId,
        methodologyVersion: source.methodologyVersion,
        exposureBands: bands,
        createdByUserId: actorUserId,
        revisesAssessmentId: source.id,
      });
      const items = await this.items.itemsOf(tx, source.id);
      for (const item of items) {
        // The ratings carry over; the derived numbers are re-scored under the bands this cycle froze, so the
        // copy is consistent with the policy it was opened under even if the thresholds moved since.
        const derived = scoreItem(item, bands);
        await this.items.create(tx, {
          assessmentId: created.id,
          governanceAreaId: item.governanceAreaId,
          requirementId: item.requirementId,
          businessUnitId: item.businessUnitId,
          frameworkId: item.frameworkId,
          currentMaturity: item.currentMaturity,
          targetMaturity: item.targetMaturity,
          sensitivity: item.sensitivity,
          severity: item.severity,
          likelihood: item.likelihood,
          gap: derived.gap,
          exposure: derived.exposure,
          riskLevel: derived.riskLevel,
          rationale: item.rationale,
          findings: item.findings,
          ownerMembershipId: item.ownerMembershipId,
          lastReviewDate: item.lastReviewDate,
          nextReviewDate: item.nextReviewDate,
        });
      }
      await this.audit.record(tx, {
        action: 'assessment.revised',
        entityType: 'assessment',
        entityId: created.id,
        entityLabel: created.title,
        changes: { revisesAssessmentId: source.id, copiedItems: items.length },
      });
      return toDto(created);
    });
  }

  /** Every cycle of this line, oldest first, with the sign-off of each (AC-GOV-04). */
  async history(id: string): Promise<AssessmentHistoryDto> {
    return this.uow.run(async (tx) => {
      const current = await this.mustFind(tx, id);
      const line = new Map<string, AssessmentRecord>([[current.id, current]]);

      for (let parentId = current.revisesAssessmentId; parentId;) {
        const seen = line.get(parentId);
        if (seen) break;
        const parent = await this.assessments.findById(tx, parentId);
        if (!parent) break;
        line.set(parent.id, parent);
        parentId = parent.revisesAssessmentId;
      }
      const pending = [current.id];
      while (pending.length > 0) {
        const from = pending.shift();
        if (from === undefined) break;
        for (const child of await this.assessments.revisionsOf(tx, from)) {
          if (line.has(child.id)) continue;
          line.set(child.id, child);
          pending.push(child.id);
        }
      }

      const entries = [...line.values()]
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .map((record) => toEntry(record, current.id));
      return { revisesAssessmentId: current.revisesAssessmentId, entries };
    });
  }

  /**
   * The roll-up of a cycle's items (AC-GOV-03): unassessed items are dropped from every average and only
   * counted in `applicable`, so an unrated cycle reports null and "nothing assessed", never zero.
   */
  async summary(id: string, filters: ItemFilterQueryDto): Promise<AssessmentSummaryDto> {
    return this.uow.run(async (tx) => {
      const current = await this.mustFind(tx, id);
      const rows = await this.items.metricsOf(tx, {
        assessmentId: id,
        ...(filters.businessUnitId ? { businessUnitId: filters.businessUnitId } : {}),
        ...(filters.frameworkId ? { frameworkId: filters.frameworkId } : {}),
      });
      const summary = summarise(rows);
      return {
        assessmentId: current.id,
        status: current.status,
        itemCount: rows.length,
        averageMaturity: summary.averageMaturity,
        averageGap: summary.averageGap,
        averageExposure: summary.averageExposure,
        highOrCritical: summary.highOrCritical,
        byRiskLevel: summary.byRiskLevel,
        notRated: summary.notRated,
        disclaimer: SCORING_DISCLAIMER,
      };
    });
  }

  private async mustFind(tx: Tx, id: string): Promise<AssessmentRecord> {
    const record = await this.assessments.findById(tx, id);
    if (!record) throw notFound();
    return record;
  }

  /** The cycle the caller wants to revise, with the state that makes it revisable. */
  private async revisableTarget(tx: Tx, id: string): Promise<void> {
    const target = await this.assessments.findById(tx, id);
    if (!target) {
      throw invalid([
        {
          path: 'revisesAssessmentId',
          code: 'unknownAssessment',
          message: 'No assessment of this organisation has this id.',
        },
      ]);
    }
    if (!REVISABLE.includes(target.status)) {
      throw invalid([
        {
          path: 'revisesAssessmentId',
          code: 'notApprovedForRevision',
          message: 'Only an approved or superseded assessment can be revised.',
        },
      ]);
    }
  }

  /** The shared PATCH shape: read, guard, collect changes, write, audit, answer. */
  private async change(
    tx: Tx,
    id: string,
    version: number,
    collect: (current: AssessmentRecord) => {
      changes: AssessmentChanges;
      audited: Record<string, unknown>;
    },
  ): Promise<AssessmentDto> {
    const current = await this.mustFind(tx, id);
    if (current.version !== version) throw versionConflict();
    const { changes, audited } = collect(current);
    if (Object.keys(changes).length === 0) return toDto(current);
    if (!(await this.assessments.update(tx, id, version, changes))) throw versionConflict();
    await this.audit.record(tx, {
      action: 'assessment.updated',
      entityType: 'assessment',
      entityId: id,
      entityLabel: current.title,
      changes: audited,
    });
    return this.readBack(tx, id);
  }

  /** A status change plus its attribution, in the caller's transaction with its audit event. */
  private async write(
    tx: Tx,
    current: AssessmentRecord,
    version: number,
    changes: AssessmentChanges,
    action: AuditAction,
    audited: Record<string, unknown>,
  ): Promise<AssessmentDto> {
    if (!(await this.assessments.update(tx, current.id, version, changes))) {
      throw versionConflict();
    }
    await this.audit.record(tx, {
      action,
      entityType: 'assessment',
      entityId: current.id,
      entityLabel: current.title,
      changes: audited,
    });
    return this.readBack(tx, current.id);
  }

  private async readBack(tx: Tx, id: string): Promise<AssessmentDto> {
    const record = await this.mustFind(tx, id);
    return toDto(record);
  }

  /** The approved cycle a revision replaced. It keeps every item and its sign-off; only its state moves. */
  private async supersedeRevised(tx: Tx, previousId: string, replacingId: string): Promise<void> {
    const previous = await this.assessments.findById(tx, previousId);
    if (!previous || previous.status !== 'APPROVED') return;
    if (!(await this.assessments.supersede(tx, previousId))) return;
    await this.audit.record(tx, {
      action: 'assessment.superseded',
      entityType: 'assessment',
      entityId: previousId,
      entityLabel: previous.title,
      changes: { supersededById: replacingId },
    });
  }
}
