import { HttpStatus, Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { Clock } from '../common/clock.js';
import { AppException, ErrorCode } from '../common/errors/app.exception.js';
import { isUniqueViolation } from '../common/errors/unique-violation.js';
import { pageSizeOf, toPage } from '../common/pagination.js';
import type { Tx } from '../database/db-client.js';
import { UnitOfWork } from '../database/unit-of-work.js';
import { todayIn } from '../domain/remediation/policy.js';
import {
  REVIEW_LEAD_DAYS,
  reviewViewOf,
  toDateOnly,
  utcDay,
  type ReviewState,
} from '../domain/registers/review.js';
import { RequestContext } from '../tenancy/request-context.js';
import type {
  CreateRopaActivityDto,
  ListRopaActivitiesQueryDto,
  RopaActivityDetailDto,
  RopaActivityDto,
  RopaActivityPageDto,
  RopaActivityVersionDto,
  RopaMonitorDto,
  UpdateRopaActivityDto,
} from './ropa.dto.js';
import { RopaRepository, type ActivityFields, type ActivityRecord } from './ropa.repository.js';

const notFound = (what: string) =>
  new AppException(ErrorCode.NotFound, HttpStatus.NOT_FOUND, `${what} not found.`);
const versionConflict = () =>
  new AppException(
    ErrorCode.VersionConflict,
    HttpStatus.CONFLICT,
    'This processing activity was changed by someone else. Reload and try again.',
  );
const archivedConflict = () =>
  new AppException(
    ErrorCode.Conflict,
    HttpStatus.CONFLICT,
    'An archived processing activity cannot be edited. Restore it first.',
  );
const invalid = (path: string, code: string, message: string) =>
  new AppException(
    ErrorCode.ValidationFailed,
    HttpStatus.BAD_REQUEST,
    'Request validation failed.',
    [{ path, code, message }],
  );

/** The free-text columns, in the order the register prints them. */
const TEXT_FIELDS = [
  'purpose',
  'dataSubjects',
  'personalDataCategories',
  'recipients',
  'processors',
  'retention',
  'internationalTransfers',
  'transferCountries',
  'securityMeasures',
] as const;

/** Everything a person can write on an activity except the name and the dates. */
const LINK_FIELDS = ['businessUnitId', 'classificationLevelId', 'retentionRuleId'] as const;

/** The row plus the review state, decided against the organisation's own calendar day. */
const toDto = (record: ActivityRecord, today: string) => {
  const view = reviewViewOf(
    toDateOnly(record.nextReviewDate),
    toDateOnly(record.lastReviewDate),
    today,
    record.reviewLeadDays ?? REVIEW_LEAD_DAYS,
  );
  return {
    id: record.id,
    name: record.name,
    businessUnitId: record.businessUnitId,
    businessUnitName: record.businessUnitName,
    classificationLevelId: record.classificationLevelId,
    classificationLevelName: record.classificationLevelName,
    classificationLevelRank: record.classificationLevelRank,
    retentionRuleId: record.retentionRuleId,
    retentionRuleName: record.retentionRuleName,
    purpose: record.purpose,
    dataSubjects: record.dataSubjects,
    personalDataCategories: record.personalDataCategories,
    recipients: record.recipients,
    processors: record.processors,
    retention: record.retention,
    internationalTransfers: record.internationalTransfers,
    transferCountries: record.transferCountries,
    securityMeasures: record.securityMeasures,
    ownerMembershipId: record.ownerMembershipId,
    ownerName: record.ownerName,
    status: record.status,
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

/**
 * The Record of Processing Activities. One line per processing operation, with the article 30 columns
 * the organisation has actually answered and nothing invented for the rest: a blank field stays blank,
 * and a missing review date is `not_reviewed`, never "on time". Activities are archived, never deleted,
 * because the register is the history of what was done with personal data.
 */
@Injectable()
export class RopaService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly activities: RopaRepository,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly requestContext: RequestContext,
  ) {}

  async list(query: ListRopaActivitiesQueryDto): Promise<RopaActivityPageDto> {
    const limit = pageSizeOf(query);
    const { rows, today } = await this.uow.run(async (tx) => ({
      rows: await this.activities.list(tx, {
        limit,
        ...(query.after ? { after: query.after } : {}),
        ...(query.q ? { q: query.q } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(query.businessUnitId ? { businessUnitId: query.businessUnitId } : {}),
        ...(query.classificationLevelId
          ? { classificationLevelId: query.classificationLevelId }
          : {}),
        ...(query.retentionRuleId ? { retentionRuleId: query.retentionRuleId } : {}),
      }),
      today: await this.today(tx),
    }));
    const page = toPage(rows, limit);
    return { items: page.items.map((row) => toDto(row, today)), nextCursor: page.nextCursor };
  }

  async detail(id: string): Promise<RopaActivityDetailDto> {
    return this.uow.run(async (tx) => {
      const record = await this.mustFind(tx, id);
      const evidenceIds = await this.activities.evidenceIdsFor(tx, id);
      return { ...toDto(record, await this.today(tx)), evidenceIds };
    });
  }

  /** A new activity starts as DRAFT unless the caller says it is already in force. */
  async create(dto: CreateRopaActivityDto): Promise<RopaActivityDto> {
    try {
      return await this.uow.run(async (tx) => {
        const fields: ActivityFields = {
          name: dto.name,
          businessUnitId: dto.businessUnitId ?? null,
          classificationLevelId: dto.classificationLevelId ?? null,
          retentionRuleId: dto.retentionRuleId ?? null,
          purpose: dto.purpose ?? null,
          dataSubjects: dto.dataSubjects ?? null,
          personalDataCategories: dto.personalDataCategories ?? null,
          recipients: dto.recipients ?? null,
          processors: dto.processors ?? null,
          retention: dto.retention ?? null,
          internationalTransfers: dto.internationalTransfers ?? null,
          transferCountries: dto.transferCountries ?? null,
          securityMeasures: dto.securityMeasures ?? null,
          ownerMembershipId: dto.ownerMembershipId ?? null,
          status: dto.status ?? 'DRAFT',
          reviewIntervalDays: dto.reviewIntervalDays ?? null,
          reviewLeadDays: dto.reviewLeadDays ?? null,
          lastReviewDate: dto.lastReviewDate ? utcDay(dto.lastReviewDate) : null,
          nextReviewDate: dto.nextReviewDate ? utcDay(dto.nextReviewDate) : null,
        };
        this.assertDates(fields);
        await this.assertSubjects(tx, fields);
        await this.assertOwner(tx, fields.ownerMembershipId);
        const created = await this.activities.create(tx, fields);
        await this.audit.record(tx, {
          action: 'ropa_activity.created',
          entityType: 'ropa_activity',
          entityId: created.id,
          entityLabel: created.name,
          changes: { status: created.status },
        });
        return toDto(created, await this.today(tx));
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new AppException(
          ErrorCode.Conflict,
          HttpStatus.CONFLICT,
          'Another processing activity was saved at the same moment. Reload and try again.',
        );
      }
      throw error;
    }
  }

  async update(id: string, dto: UpdateRopaActivityDto): Promise<RopaActivityDto> {
    return this.uow.run(async (tx) => {
      const current = await this.mustFind(tx, id);
      if (current.version !== dto.version) throw versionConflict();
      if (current.archivedAt) throw archivedConflict();

      const changes: Partial<ActivityFields> = {};
      const audited: Record<string, unknown> = {};
      if (dto.name !== undefined && dto.name !== current.name) {
        changes.name = dto.name;
        audited.name = { from: current.name, to: dto.name };
      }
      for (const key of TEXT_FIELDS) {
        const next = dto[key];
        if (next !== undefined && next !== current[key]) {
          changes[key] = next;
          // the content of a register line is personal-data detail: the trail records that it changed, not what it said
          audited[key] = 'changed';
        }
      }
      for (const key of LINK_FIELDS) {
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
      if (dto.status !== undefined && dto.status !== current.status) {
        changes.status = dto.status;
        audited.status = { from: current.status, to: dto.status };
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
      if (!(await this.activities.update(tx, id, dto.version, changes))) throw versionConflict();
      await this.audit.record(tx, {
        action: 'ropa_activity.updated',
        entityType: 'ropa_activity',
        entityId: id,
        entityLabel: changes.name ?? current.name,
        changes: audited,
      });
      const fresh = await this.activities.findById(tx, id); // the joined names may have changed
      return toDto(fresh ?? current, await this.today(tx));
    });
  }

  /** Archives the activity (status and flag move together). Idempotent. */
  archive(id: string, dto: RopaActivityVersionDto): Promise<RopaActivityDto> {
    return this.uow.run(async (tx) => {
      const current = await this.mustFind(tx, id);
      if (current.archivedAt) return toDto(current, await this.today(tx));
      if (current.version !== dto.version) throw versionConflict();
      const archivedAt = this.clock.now();
      if (
        !(await this.activities.update(tx, id, dto.version, {
          archivedAt,
          status: 'ARCHIVED',
        }))
      ) {
        throw versionConflict();
      }
      await this.audit.record(tx, {
        action: 'ropa_activity.archived',
        entityType: 'ropa_activity',
        entityId: id,
        entityLabel: current.name,
      });
      return toDto(
        { ...current, archivedAt, status: 'ARCHIVED', version: current.version + 1 },
        await this.today(tx),
      );
    });
  }

  /** Restoring sends the line back to DRAFT: it is read and confirmed again before it counts as current. */
  unarchive(id: string, dto: RopaActivityVersionDto): Promise<RopaActivityDto> {
    return this.uow.run(async (tx) => {
      const current = await this.mustFind(tx, id);
      if (!current.archivedAt) return toDto(current, await this.today(tx));
      if (current.version !== dto.version) throw versionConflict();
      if (
        !(await this.activities.update(tx, id, dto.version, { archivedAt: null, status: 'DRAFT' }))
      ) {
        throw versionConflict();
      }
      await this.audit.record(tx, {
        action: 'ropa_activity.unarchived',
        entityType: 'ropa_activity',
        entityId: id,
        entityLabel: current.name,
      });
      return toDto(
        { ...current, archivedAt: null, status: 'DRAFT', version: current.version + 1 },
        await this.today(tx),
      );
    });
  }

  /** Links evidence that already exists in this organisation. Linking twice is not an error. */
  linkEvidence(id: string, evidenceId: string): Promise<RopaActivityDetailDto> {
    return this.uow.run(async (tx) => {
      const current = await this.mustFind(tx, id);
      const evidence = await this.activities.findEvidence(tx, evidenceId);
      if (!evidence) throw notFound('Evidence');
      const added = await this.activities.linkEvidence(tx, id, evidenceId, this.actorUserId());
      if (added) {
        await this.audit.record(tx, {
          action: 'ropa_activity.evidence_linked',
          entityType: 'ropa_activity',
          entityId: id,
          entityLabel: current.name,
          changes: { evidenceId, evidenceTitle: evidence.title },
        });
      }
      return this.detailIn(tx, current);
    });
  }

  async unlinkEvidence(id: string, evidenceId: string): Promise<RopaActivityDetailDto> {
    return this.uow.run(async (tx) => {
      const current = await this.mustFind(tx, id);
      const removed = await this.activities.unlinkEvidence(tx, id, evidenceId);
      if (removed) {
        await this.audit.record(tx, {
          action: 'ropa_activity.evidence_unlinked',
          entityType: 'ropa_activity',
          entityId: id,
          entityLabel: current.name,
          changes: { evidenceId },
        });
      }
      return this.detailIn(tx, current);
    });
  }

  /** How much of the register needs attention, counted on the server in the organisation's own day. */
  monitor(): Promise<RopaMonitorDto> {
    return this.uow.run(async (tx) => {
      const today = await this.today(tx);
      const rows = await this.activities.listLive(tx);
      if (rows.length === 0) {
        return {
          availability: 'no_records' as const,
          asOf: today,
          total: 0,
          overdue: 0,
          dueSoon: 0,
          onTrack: 0,
          notReviewed: 0,
        };
      }
      const counts = new Map<ReviewState, number>();
      for (const row of rows) {
        const { state } = reviewViewOf(
          toDateOnly(row.nextReviewDate),
          toDateOnly(row.lastReviewDate),
          today,
          row.reviewLeadDays ?? REVIEW_LEAD_DAYS,
        );
        counts.set(state, (counts.get(state) ?? 0) + 1);
      }
      const overdue = counts.get('overdue') ?? 0;
      const dueSoon = counts.get('due_soon') ?? 0;
      const notReviewed = counts.get('not_reviewed') ?? 0;
      return {
        // with no approved due date anywhere there is nothing to monitor: the register is not configured yet
        availability: notReviewed === rows.length ? ('not_configured' as const) : ('ok' as const),
        asOf: today,
        total: rows.length,
        overdue,
        dueSoon,
        onTrack: rows.length - overdue - dueSoon - notReviewed,
        notReviewed,
      };
    });
  }

  // ---- the checks, all of them here and none of them in the controller

  private async mustFind(tx: Tx, id: string): Promise<ActivityRecord> {
    const record = await this.activities.findById(tx, id);
    if (!record) throw notFound('Processing activity');
    return record;
  }

  private async detailIn(tx: Tx, record: ActivityRecord): Promise<RopaActivityDetailDto> {
    const evidenceIds = await this.activities.evidenceIdsFor(tx, record.id);
    return { ...toDto(record, await this.today(tx)), evidenceIds };
  }

  /** Today in the organisation's own zone: a review date never means anything in the server's zone. */
  private async today(tx: Tx): Promise<string> {
    return todayIn(await this.activities.timezone(tx), this.clock.now());
  }

  /** A review dated after the next review is a mistake, not a state. */
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

  /** Every subject must exist in THIS organisation; a level or rule must also still be active. */
  private async assertSubjects(tx: Tx, fields: ActivityFields): Promise<void> {
    if (
      fields.businessUnitId &&
      !(await this.activities.findBusinessUnit(tx, fields.businessUnitId))
    ) {
      throw invalid(
        'businessUnitId',
        'unknownBusinessUnit',
        'The business unit does not exist in this organisation.',
      );
    }
    if (fields.classificationLevelId) {
      const level = await this.activities.findLevel(tx, fields.classificationLevelId);
      if (!level) {
        throw invalid(
          'classificationLevelId',
          'unknownClassificationLevel',
          'The classification level does not exist in this organisation.',
        );
      }
      if (level.archivedAt) {
        throw invalid(
          'classificationLevelId',
          'classificationLevelArchived',
          'That classification level is archived. Choose an active one.',
        );
      }
    }
    if (fields.retentionRuleId) {
      const rule = await this.activities.findRule(tx, fields.retentionRuleId);
      if (!rule) {
        throw invalid(
          'retentionRuleId',
          'unknownRetentionRule',
          'The retention rule does not exist in this organisation.',
        );
      }
      if (rule.archivedAt) {
        throw invalid(
          'retentionRuleId',
          'retentionRuleArchived',
          'That retention rule is archived. Choose an active one.',
        );
      }
    }
  }

  private async assertOwner(tx: Tx, ownerMembershipId: string | null): Promise<void> {
    if (ownerMembershipId && !(await this.activities.findActiveMember(tx, ownerMembershipId))) {
      throw invalid(
        'ownerMembershipId',
        'notAnActiveMember',
        'The owner must be an active member of this organisation.',
      );
    }
  }

  /** The person a change is attributed to; a register line's evidence link is always attributed. */
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
