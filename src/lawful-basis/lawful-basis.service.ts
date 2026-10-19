import { HttpStatus, Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { Clock } from '../common/clock.js';
import { AppException, ErrorCode } from '../common/errors/app.exception.js';
import { pageSizeOf, toPage } from '../common/pagination.js';
import type { Tx } from '../database/db-client.js';
import { UnitOfWork } from '../database/unit-of-work.js';
import { todayIn } from '../domain/remediation/policy.js';
import {
  findBasisReviewTransition,
  nextBasisReviewStatuses,
  type LawfulBasisReviewStatus,
} from '../domain/registers/records.js';
import { REVIEW_LEAD_DAYS, reviewViewOf, toDateOnly, utcDay } from '../domain/registers/review.js';
import { roleHas, type Permission } from '../permissions/catalogue.js';
import { RequestContext } from '../tenancy/request-context.js';
import { LawfulBasisRepository } from './lawful-basis.repository.js';
import type { BasisFields, BasisRecord } from './lawful-basis.repository.js';
import type {
  CreateLawfulBasisRecordDto,
  LawfulBasisRecordDetailDto,
  LawfulBasisRecordDto,
  LawfulBasisRecordPageDto,
  LawfulBasisRecordVersionDto,
  ListLawfulBasisQueryDto,
  ReviewLawfulBasisRecordDto,
  UpdateLawfulBasisRecordDto,
} from './lawful-basis.dto.js';

const notFound = (what: string) =>
  new AppException(ErrorCode.NotFound, HttpStatus.NOT_FOUND, `${what} not found.`);
const versionConflict = () =>
  new AppException(
    ErrorCode.VersionConflict,
    HttpStatus.CONFLICT,
    'This lawful basis record was changed by someone else. Reload and try again.',
  );
const archivedConflict = () =>
  new AppException(
    ErrorCode.Conflict,
    HttpStatus.CONFLICT,
    'An archived lawful basis record cannot be changed. Restore it first.',
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

/** 409 with the moves that ARE possible spelled out, so the caller never has to guess the lifecycle. */
const invalidTransition = (
  from: LawfulBasisReviewStatus,
  to: LawfulBasisReviewStatus,
  allowed: readonly LawfulBasisReviewStatus[],
) =>
  new AppException(
    ErrorCode.InvalidTransition,
    HttpStatus.CONFLICT,
    `A basis record that is ${from} cannot go straight to ${to}. From ${from} it can move to: ` +
      (allowed.length > 0 ? allowed.join(', ') : 'nowhere — this status has no next step.') +
      ' A review decision is only allowed through the steps of the review lifecycle.',
  );

const toDto = (record: BasisRecord, today: string) => {
  const view = reviewViewOf(
    toDateOnly(record.nextReviewDate),
    toDateOnly(record.lastReviewDate),
    today,
    record.reviewLeadDays ?? REVIEW_LEAD_DAYS,
  );
  return {
    id: record.id,
    purpose: record.purpose,
    basis: record.basis,
    frameworkId: record.frameworkId,
    frameworkCode: record.frameworkCode,
    requirementId: record.requirementId,
    requirementRef: record.requirementRef,
    requirementTitle: record.requirementTitle,
    processingActivityId: record.processingActivityId,
    processingActivityName: record.processingActivityName,
    justification: record.justification,
    reviewStatus: record.reviewStatus,
    ownerMembershipId: record.ownerMembershipId,
    ownerName: record.ownerName,
    reviewIntervalDays: record.reviewIntervalDays,
    reviewLeadDays: record.reviewLeadDays,
    lastReviewDate: view.lastReviewDate,
    nextReviewDate: view.nextReviewDate,
    reviewState: view.state,
    daysRemaining: view.daysRemaining,
    archived: record.archivedAt !== null,
    archivedAt: record.archivedAt?.toISOString() ?? null,
    version: record.version,
  };
};

/** The three columns an approval is about: changing one of them takes the approval back into review. */
const DECISION_FIELDS = ['purpose', 'basis', 'justification'] as const;

/**
 * The lawful basis register. A record states one basis for one purpose and is only a claim until an
 * approver signs it off — and an approval always carries the reasoning, because a basis without an
 * argument is not a basis. Changing what the approval was about (the purpose, the basis, or the
 * reasoning) sends it back to UNDER_REVIEW: an approval never silently covers different content.
 */
@Injectable()
export class LawfulBasisService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly records: LawfulBasisRepository,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly requestContext: RequestContext,
  ) {}

  async list(query: ListLawfulBasisQueryDto): Promise<LawfulBasisRecordPageDto> {
    const limit = pageSizeOf(query);
    const { rows, today } = await this.uow.run(async (tx) => ({
      rows: await this.records.list(tx, {
        limit,
        includeArchived: query.includeArchived === true,
        ...(query.after ? { after: query.after } : {}),
        ...(query.q ? { q: query.q } : {}),
        ...(query.basis ? { basis: query.basis } : {}),
        ...(query.reviewStatus ? { reviewStatus: query.reviewStatus } : {}),
        ...(query.processingActivityId ? { processingActivityId: query.processingActivityId } : {}),
      }),
      today: await this.today(tx),
    }));
    const page = toPage(rows, limit);
    return { items: page.items.map((row) => toDto(row, today)), nextCursor: page.nextCursor };
  }

  detail(id: string): Promise<LawfulBasisRecordDetailDto> {
    return this.uow.run(async (tx) => this.detailIn(tx, await this.mustFind(tx, id)));
  }

  /** A new record always starts as DRAFT: nothing is approved at the moment it is typed. */
  async create(dto: CreateLawfulBasisRecordDto): Promise<LawfulBasisRecordDto> {
    return this.uow.run(async (tx) => {
      const fields: BasisFields = {
        purpose: dto.purpose,
        basis: dto.basis,
        frameworkId: dto.frameworkId ?? null,
        requirementId: dto.requirementId ?? null,
        processingActivityId: dto.processingActivityId ?? null,
        justification: dto.justification ?? null,
        ownerMembershipId: dto.ownerMembershipId ?? null,
        reviewIntervalDays: dto.reviewIntervalDays ?? null,
        reviewLeadDays: dto.reviewLeadDays ?? null,
        lastReviewDate: dto.lastReviewDate ? utcDay(dto.lastReviewDate) : null,
        nextReviewDate: dto.nextReviewDate ? utcDay(dto.nextReviewDate) : null,
      };
      this.assertDates(fields);
      await this.assertSubjects(tx, fields);
      await this.assertOwner(tx, fields.ownerMembershipId);
      const created = await this.records.create(tx, fields);
      await this.audit.record(tx, {
        action: 'lawful_basis_record.created',
        entityType: 'lawful_basis_record',
        entityId: created.id,
        entityLabel: created.purpose,
        changes: { basis: created.basis },
      });
      return toDto(created, await this.today(tx));
    });
  }

  async update(id: string, dto: UpdateLawfulBasisRecordDto): Promise<LawfulBasisRecordDto> {
    return this.uow.run(async (tx) => {
      const current = await this.mustFind(tx, id);
      if (current.version !== dto.version) throw versionConflict();
      if (current.archivedAt) throw archivedConflict();

      const changes: Partial<BasisFields> = {};
      const audited: Record<string, unknown> = {};
      if (dto.purpose !== undefined && dto.purpose !== current.purpose) {
        changes.purpose = dto.purpose;
        // a purpose is a description of processing: the trail records that it changed, not what it said
        audited.purpose = 'changed';
      }
      if (dto.basis !== undefined && dto.basis !== current.basis) {
        changes.basis = dto.basis;
        audited.basis = { from: current.basis, to: dto.basis };
      }
      if (dto.justification !== undefined && dto.justification !== current.justification) {
        changes.justification = dto.justification;
        audited.justification = 'changed';
      }
      for (const key of ['frameworkId', 'requirementId', 'processingActivityId'] as const) {
        const next = dto[key];
        if (next !== undefined && next !== current[key]) {
          changes[key] = next;
          audited[key] = { from: current[key], to: next };
        }
      }
      if (
        dto.ownerMembershipId !== undefined &&
        dto.ownerMembershipId !== current.ownerMembershipId
      ) {
        changes.ownerMembershipId = dto.ownerMembershipId;
        audited.ownerMembershipId = 'changed';
      }
      for (const key of ['reviewIntervalDays', 'reviewLeadDays'] as const) {
        const next = dto[key];
        if (next !== undefined && next !== current[key]) {
          changes[key] = next;
          audited[key] = { from: current[key], to: next };
        }
      }
      for (const key of ['lastReviewDate', 'nextReviewDate'] as const) {
        const next = dto[key];
        if (next === undefined) continue;
        const asDate = next ? utcDay(next) : null;
        if (toDateOnly(asDate) !== toDateOnly(current[key])) {
          changes[key] = asDate;
          audited[key] = { from: toDateOnly(current[key]), to: next };
        }
      }
      if (Object.keys(changes).length === 0) return toDto(current, await this.today(tx));

      this.assertDates({ ...current, ...changes });
      await this.assertSubjects(tx, { ...current, ...changes });
      if ('ownerMembershipId' in changes) {
        await this.assertOwner(tx, changes.ownerMembershipId ?? null);
      }

      // an approval covers the content it was given for: change that content and it is under review again
      const touchesDecision = DECISION_FIELDS.some((key) => key in changes);
      const backToReview = current.reviewStatus === 'APPROVED' && touchesDecision;
      if (backToReview) {
        audited.reviewStatus = {
          from: 'APPROVED',
          to: 'UNDER_REVIEW',
          reason: 'the basis, the purpose or the reasoning changed',
        };
      }

      if (
        !(await this.records.update(tx, id, dto.version, {
          ...changes,
          ...(backToReview ? { reviewStatus: 'UNDER_REVIEW' as const } : {}),
        }))
      ) {
        throw versionConflict();
      }
      await this.audit.record(tx, {
        action: 'lawful_basis_record.updated',
        entityType: 'lawful_basis_record',
        entityId: id,
        entityLabel: changes.purpose ?? current.purpose,
        changes: audited,
      });
      const fresh = await this.records.findById(tx, id); // the joined names may have changed
      return toDto(fresh ?? current, await this.today(tx));
    });
  }

  /** Archives the record: hidden from the register, kept for history. Idempotent. */
  archive(id: string, dto: LawfulBasisRecordVersionDto): Promise<LawfulBasisRecordDto> {
    return this.setArchived(id, dto.version, true);
  }

  unarchive(id: string, dto: LawfulBasisRecordVersionDto): Promise<LawfulBasisRecordDto> {
    return this.setArchived(id, dto.version, false);
  }

  /**
   * The review decision. `by: 'approve'` steps need `governance.approve`; an approval needs the
   * justification it approves; taking an approval back needs a reason. Approving records the review day
   * and resets the next one — either to the date given here or to none, never to an invented date.
   */
  review(id: string, dto: ReviewLawfulBasisRecordDto): Promise<LawfulBasisRecordDetailDto> {
    return this.uow.run(async (tx) => {
      const current = await this.mustFind(tx, id);
      if (current.version !== dto.version) throw versionConflict();
      if (current.archivedAt) throw archivedConflict();

      const transition = findBasisReviewTransition(current.reviewStatus, dto.toStatus);
      if (!transition) {
        throw invalidTransition(
          current.reviewStatus,
          dto.toStatus,
          nextBasisReviewStatuses(current.reviewStatus).map((step) => step.to),
        );
      }
      if (transition.by === 'approve' && !this.caller().may('governance.approve')) {
        throw forbidden(`move a basis record from ${transition.from} to ${transition.to}`);
      }
      if (transition.needsReason && !dto.reason) {
        throw invalid(
          'reason',
          'reasonRequired',
          dto.toStatus === 'APPROVED'
            ? 'Say why this basis is the right one.'
            : 'Taking a review decision back needs a reason: say why.',
        );
      }

      const changes: Partial<BasisFields> & { reviewStatus: LawfulBasisReviewStatus } = {
        reviewStatus: dto.toStatus,
      };
      if (dto.justification !== undefined && dto.justification !== current.justification) {
        changes.justification = dto.justification;
      }
      if (dto.toStatus === 'APPROVED') {
        const text = changes.justification ?? current.justification;
        if (!text || text.trim().length < 3) {
          throw invalid(
            'justification',
            'justificationRequired',
            'An approval has to carry the reasoning that supports it.',
          );
        }
        const today = await this.today(tx);
        if (dto.nextReviewDate && dto.nextReviewDate <= today) {
          throw invalid(
            'nextReviewDate',
            'notInTheFuture',
            `The next review must be after today in the organisation's zone (${today}).`,
          );
        }
        changes.lastReviewDate = utcDay(today);
        // the review is done: the next date is either the one given now or none at all
        changes.nextReviewDate = dto.nextReviewDate ? utcDay(dto.nextReviewDate) : null;
      }

      if (!(await this.records.update(tx, id, dto.version, changes))) throw versionConflict();
      await this.audit.record(tx, {
        action: 'lawful_basis_record.review_status_changed',
        entityType: 'lawful_basis_record',
        entityId: id,
        entityLabel: current.purpose,
        changes: {
          reviewStatus: { from: transition.from, to: transition.to },
          ...(dto.reason ? { reason: dto.reason } : {}),
          ...(dto.justification !== undefined ? { justification: 'changed' } : {}),
        },
      });
      const fresh = await this.records.findById(tx, id);
      if (!fresh) throw notFound('Lawful basis record');
      return this.detailIn(tx, fresh);
    });
  }

  /** Attaches an evidence file this organisation has uploaded. Linking the same file twice changes nothing. */
  linkEvidence(id: string, evidenceId: string): Promise<LawfulBasisRecordDetailDto> {
    return this.uow.run(async (tx) => {
      const current = await this.mustFind(tx, id);
      const evidence = await this.records.findEvidence(tx, evidenceId);
      if (!evidence) throw notFound('Evidence');
      const added = await this.records.linkEvidence(tx, id, evidenceId, this.actorUserId());
      if (added) {
        await this.audit.record(tx, {
          action: 'lawful_basis_record.evidence_linked',
          entityType: 'lawful_basis_record',
          entityId: id,
          entityLabel: current.purpose,
          changes: { evidenceId, evidenceTitle: evidence.title },
        });
      }
      return this.detailIn(tx, current);
    });
  }

  unlinkEvidence(id: string, evidenceId: string): Promise<LawfulBasisRecordDetailDto> {
    return this.uow.run(async (tx) => {
      const current = await this.mustFind(tx, id);
      const removed = await this.records.unlinkEvidence(tx, id, evidenceId);
      if (removed) {
        await this.audit.record(tx, {
          action: 'lawful_basis_record.evidence_unlinked',
          entityType: 'lawful_basis_record',
          entityId: id,
          entityLabel: current.purpose,
          changes: { evidenceId },
        });
      }
      return this.detailIn(tx, current);
    });
  }

  // ---- the checks, all of them here and none of them in the controller

  private async setArchived(
    id: string,
    version: number,
    archived: boolean,
  ): Promise<LawfulBasisRecordDto> {
    return this.uow.run(async (tx) => {
      const current = await this.mustFind(tx, id);
      if ((current.archivedAt !== null) === archived) return toDto(current, await this.today(tx));
      if (current.version !== version) throw versionConflict();
      const archivedAt = archived ? this.clock.now() : null;
      if (!(await this.records.update(tx, id, version, { archivedAt }))) {
        throw versionConflict();
      }
      await this.audit.record(tx, {
        action: archived ? 'lawful_basis_record.archived' : 'lawful_basis_record.unarchived',
        entityType: 'lawful_basis_record',
        entityId: id,
        entityLabel: current.purpose,
      });
      return toDto({ ...current, archivedAt, version: current.version + 1 }, await this.today(tx));
    });
  }

  private async mustFind(tx: Tx, id: string): Promise<BasisRecord> {
    const record = await this.records.findById(tx, id);
    if (!record) throw notFound('Lawful basis record');
    return record;
  }

  private async detailIn(tx: Tx, record: BasisRecord): Promise<LawfulBasisRecordDetailDto> {
    const evidenceIds = await this.records.evidenceIdsFor(tx, record.id);
    return { ...toDto(record, await this.today(tx)), evidenceIds };
  }

  /** Today in the organisation's own zone: a review date never means anything in the server's zone. */
  private async today(tx: Tx): Promise<string> {
    return todayIn(await this.records.timezone(tx), this.clock.now());
  }

  private assertDates(fields: { lastReviewDate: Date | null; nextReviewDate: Date | null }): void {
    const last = toDateOnly(fields.lastReviewDate);
    const next = toDateOnly(fields.nextReviewDate);
    if (last && next && next <= last) {
      throw invalid(
        'nextReviewDate',
        'notAfterLastReview',
        'The next review must be on a later day than the last review.',
      );
    }
  }

  private async assertSubjects(tx: Tx, fields: BasisFields): Promise<void> {
    if (fields.frameworkId && !(await this.records.findFramework(tx, fields.frameworkId))) {
      throw invalid('frameworkId', 'unknownFramework', 'The framework does not exist.');
    }
    if (fields.requirementId && !(await this.records.findRequirement(tx, fields.requirementId))) {
      throw invalid('requirementId', 'unknownRequirement', 'The requirement does not exist.');
    }
    if (fields.processingActivityId) {
      const activity = await this.records.findActivity(tx, fields.processingActivityId);
      if (!activity) {
        throw invalid(
          'processingActivityId',
          'unknownRopaActivity',
          'The processing activity does not exist in this organisation.',
        );
      }
      if (activity.archivedAt) {
        throw invalid(
          'processingActivityId',
          'ropaActivityArchived',
          'That processing activity is archived. Restore it or choose another one.',
        );
      }
    }
  }

  private async assertOwner(tx: Tx, ownerMembershipId: string | null): Promise<void> {
    if (ownerMembershipId && !(await this.records.findActiveMember(tx, ownerMembershipId))) {
      throw invalid(
        'ownerMembershipId',
        'notAnActiveMember',
        'The owner must be an active member of this organisation.',
      );
    }
  }

  private caller(): { may: (permission: Permission) => boolean } {
    const { role } = this.requestContext.get();
    return { may: (permission) => role !== undefined && roleHas(role, permission) };
  }

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
