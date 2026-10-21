import { HttpStatus, Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { Clock } from '../common/clock.js';
import { AppException, ErrorCode } from '../common/errors/app.exception.js';
import { isUniqueViolation } from '../common/errors/unique-violation.js';
import { pageSizeOf, toPage } from '../common/pagination.js';
import type { Tx } from '../database/db-client.js';
import { UnitOfWork } from '../database/unit-of-work.js';
import { todayIn } from '../domain/remediation/policy.js';
import type { LawfulBasisKind } from '../domain/registers/records.js';
import {
  REVIEW_LEAD_DAYS,
  reviewViewOf,
  toDateOnly,
  utcDay,
  type ReviewState,
} from '../domain/registers/review.js';
import { RequestContext } from '../tenancy/request-context.js';
import { NEEDS_REVIEW_LIST_MAX } from './ropa.dto.js';
import type {
  CreateRopaActivityDto,
  LinkRopaLawfulBasisDto,
  ListRopaActivitiesQueryDto,
  RopaActivityDetailDto,
  RopaActivityDto,
  RopaActivityPageDto,
  RopaActivityVersionDto,
  RopaMonitorDto,
  UpdateRopaActivityDto,
} from './ropa.dto.js';
import {
  RopaRepository,
  type ActivityFields,
  type ActivityRecord,
  type RopaBasisLink,
} from './ropa.repository.js';

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
    lawfulBasisRecords: record.lawfulBasis,
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
        // The basis stated while the activity was being recorded is its own DRAFT record, pointing here.
        if (dto.lawfulBasis) {
          await this.recordBasis(tx, created, dto.lawfulBasis, dto.purpose ?? null);
        }
        const fresh = dto.lawfulBasis ? await this.mustFind(tx, created.id) : created;
        return toDto(fresh, await this.today(tx));
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

  /**
   * States a lawful basis for this activity by creating a DRAFT basis record that points at it. The basis
   * register owns its own review; the link is only which side of the register the answer sits on.
   */
  async linkLawfulBasis(id: string, dto: LinkRopaLawfulBasisDto): Promise<RopaActivityDetailDto> {
    return this.uow.run(async (tx) => {
      const current = await this.mustFind(tx, id);
      await this.recordBasis(tx, current, dto.basis, dto.purpose ?? null);
      return this.detailIn(tx, await this.mustFind(tx, id)); // the new link is in the row it returns
    });
  }

  /** Detaches the basis record; the record itself stays in the lawful basis register. Idempotent. */
  async unlinkLawfulBasis(id: string, recordId: string): Promise<RopaActivityDetailDto> {
    return this.uow.run(async (tx) => {
      const current = await this.mustFind(tx, id);
      const removed = await this.activities.unlinkBasisRecord(tx, id, recordId);
      if (removed) {
        await this.audit.record(tx, {
          action: 'ropa_activity.lawful_basis_unlinked',
          entityType: 'ropa_activity',
          entityId: id,
          entityLabel: current.name,
          changes: { lawfulBasisRecordId: recordId },
        });
        return this.detailIn(tx, await this.mustFind(tx, id));
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
          linkedToLawfulBasis: 0,
          linkedToClassification: 0,
          unlinked: 0,
          byBusinessUnit: [],
          needsReview: [],
          needsReviewLimit: NEEDS_REVIEW_LIST_MAX,
          needsReviewTruncated: false,
        };
      }
      const views = rows.map((row) => ({
        row,
        view: reviewViewOf(
          toDateOnly(row.nextReviewDate),
          toDateOnly(row.lastReviewDate),
          today,
          row.reviewLeadDays ?? REVIEW_LEAD_DAYS,
        ),
      }));
      const counts = new Map<ReviewState, number>();
      for (const { view } of views) {
        counts.set(view.state, (counts.get(view.state) ?? 0) + 1);
      }
      const overdue = counts.get('overdue') ?? 0;
      const dueSoon = counts.get('due_soon') ?? 0;
      const notReviewed = counts.get('not_reviewed') ?? 0;
      const hasBasis = (row: ActivityRecord) => row.lawfulBasis.length > 0;
      const hasClass = (row: ActivityRecord) => row.classificationLevelId !== null;

      const units = new Map<string | null, { name: string | null; activities: number }>();
      for (const { row } of views) {
        const group = units.get(row.businessUnitId);
        if (group) group.activities += 1;
        else
          units.set(row.businessUnitId, {
            name: row.businessUnitName,
            activities: 1,
          });
      }

      // a state that needs attention always has both a due date and a count against it, so a row whose date
      // is absent (not_reviewed, ok) falls out here instead of being asserted away further down
      const needing = views.flatMap(({ row, view }) => {
        if (view.state !== 'overdue' && view.state !== 'due_soon') return [];
        if (view.nextReviewDate === null || view.daysRemaining === null) return [];
        return [
          {
            row,
            state: view.state,
            nextReviewDate: view.nextReviewDate,
            lastReviewDate: view.lastReviewDate,
            daysRemaining: view.daysRemaining,
          },
        ];
      });
      // most overdue first, and the id breaks a tie so the list does not shuffle between two reads
      const ordered = needing.sort(
        (left, right) =>
          left.daysRemaining - right.daysRemaining || left.row.id.localeCompare(right.row.id),
      );
      const list = ordered.slice(0, NEEDS_REVIEW_LIST_MAX);

      return {
        // with no approved due date anywhere there is nothing to monitor: the register is not configured yet
        availability: notReviewed === rows.length ? ('not_configured' as const) : ('ok' as const),
        asOf: today,
        total: rows.length,
        overdue,
        dueSoon,
        onTrack: rows.length - overdue - dueSoon - notReviewed,
        notReviewed,
        // the traceability the register is judged on: a line with neither link says what the data is and nothing else
        linkedToLawfulBasis: rows.filter(hasBasis).length,
        linkedToClassification: rows.filter(hasClass).length,
        unlinked: rows.filter((row) => !hasBasis(row) && !hasClass(row)).length,
        // largest unit first so a bar chart reads without a client-side sort; an unassigned group is one bar
        byBusinessUnit: [...units.entries()]
          .map(([businessUnitId, group]) => ({
            businessUnitId,
            businessUnitName: group.name,
            activities: group.activities,
          }))
          .sort((left, right) => right.activities - left.activities),
        needsReview: list.map((item) => ({
          id: item.row.id,
          name: item.row.name,
          businessUnitId: item.row.businessUnitId,
          businessUnitName: item.row.businessUnitName,
          lastReviewDate: item.lastReviewDate,
          nextReviewDate: item.nextReviewDate,
          reviewState: item.state,
          daysRemaining: item.daysRemaining,
        })),
        needsReviewLimit: NEEDS_REVIEW_LIST_MAX,
        needsReviewTruncated: ordered.length > list.length,
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

  /**
   * Creates the basis record that justifies an activity. A lawful basis row needs a purpose, and the caller
   * does not always restate one: the activity's own purpose, then its name, stand in so the register line is
   * never an empty row. It starts as DRAFT, because nobody has reviewed what was just typed.
   */
  private async recordBasis(
    tx: Tx,
    activity: ActivityRecord,
    basis: LawfulBasisKind,
    purpose: string | null,
  ): Promise<RopaBasisLink> {
    const record = await this.activities.createBasisRecord(tx, {
      basis,
      purpose: (purpose ?? activity.purpose ?? activity.name).trim(),
      processingActivityId: activity.id,
    });
    await this.audit.record(tx, {
      action: 'ropa_activity.lawful_basis_linked',
      entityType: 'ropa_activity',
      entityId: activity.id,
      entityLabel: activity.name,
      changes: { basis, lawfulBasisRecordId: record.id },
    });
    return record;
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
