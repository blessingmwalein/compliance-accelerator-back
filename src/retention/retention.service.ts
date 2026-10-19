import { HttpStatus, Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { Clock } from '../common/clock.js';
import { AppException, ErrorCode } from '../common/errors/app.exception.js';
import { pageSizeOf, toPage } from '../common/pagination.js';
import type { Tx } from '../database/db-client.js';
import { UnitOfWork } from '../database/unit-of-work.js';
import { todayIn } from '../domain/remediation/policy.js';
import {
  dayOf,
  REVIEW_LEAD_DAYS,
  reviewViewOf,
  toDateOnly,
  utcDay,
} from '../domain/registers/review.js';
import { RequestContext } from '../tenancy/request-context.js';
import type {
  CreateRetentionRuleDto,
  LegalHoldDto,
  LegalHoldPageDto,
  ListLegalHoldsQueryDto,
  ListRetentionDisposalsQueryDto,
  ListRetentionRulesQueryDto,
  PlaceLegalHoldDto,
  RecordRetentionDisposalDto,
  ReleaseLegalHoldDto,
  RetentionDisposalDto,
  RetentionDisposalPageDto,
  RetentionRuleDetailDto,
  RetentionRuleDto,
  RetentionRulePageDto,
  RetentionRuleVersionDto,
  UpdateRetentionRuleDto,
} from './retention.dto.js';
import {
  RetentionRepository,
  type DisposalRecord,
  type HoldRecord,
  type RuleFields,
  type RuleRecord,
} from './retention.repository.js';

/** How many past disposals the rule detail shows. Older ones are still in the log. */
const RECENT_DISPOSALS = 20;

const notFound = (what: string) =>
  new AppException(ErrorCode.NotFound, HttpStatus.NOT_FOUND, `${what} not found.`);
const versionConflict = (what: string) =>
  new AppException(
    ErrorCode.VersionConflict,
    HttpStatus.CONFLICT,
    `This ${what} was changed by someone else. Reload and try again.`,
  );
const archivedConflict = () =>
  new AppException(
    ErrorCode.Conflict,
    HttpStatus.CONFLICT,
    'An archived retention rule cannot be changed. Restore it first.',
  );
/** Archiving a rule that live records still point at would orphan them. */
const recordInUse = (count: number) =>
  new AppException(
    ErrorCode.RecordInUse,
    HttpStatus.CONFLICT,
    count === 1
      ? 'A live processing activity still uses this rule. Move it first.'
      : `${count} live processing activities still use this rule. Move them first.`,
  );
/** A hold is the point: while it is live, nothing under it may be retired or disposed of. */
const legalHoldActive = () =>
  new AppException(
    ErrorCode.LegalHoldActive,
    HttpStatus.CONFLICT,
    'A live legal hold covers this rule. Release the hold before archiving the rule.',
  );
const disposalBlocked = () =>
  new AppException(
    ErrorCode.DisposalBlockedByHold,
    HttpStatus.CONFLICT,
    'A live legal hold covers this rule, so no disposal may be logged against it.',
  );
const invalid = (path: string, code: string, message: string) =>
  new AppException(
    ErrorCode.ValidationFailed,
    HttpStatus.BAD_REQUEST,
    'Request validation failed.',
    [{ path, code, message }],
  );

/** The rule plus its review state, decided against the organisation's own calendar day. */
const toRuleDto = (record: RuleRecord, today: string) => {
  const view = reviewViewOf(
    toDateOnly(record.nextReviewDate),
    toDateOnly(record.lastReviewDate),
    today,
    REVIEW_LEAD_DAYS,
  );
  return {
    id: record.id,
    name: record.name,
    classificationLevelId: record.classificationLevelId,
    classificationLevelName: record.classificationLevelName,
    classificationLevelRank: record.classificationLevelRank,
    dataCategory: record.dataCategory,
    systemLocation: record.systemLocation,
    triggerEvent: record.triggerEvent,
    retentionPeriodDays: record.retentionPeriodDays,
    gracePeriodDays: record.gracePeriodDays,
    disposalMethod: record.disposalMethod,
    exceptions: record.exceptions,
    ownerMembershipId: record.ownerMembershipId,
    ownerName: record.ownerName,
    lastReviewDate: view.lastReviewDate,
    nextReviewDate: view.nextReviewDate,
    reviewState: view.state,
    daysRemaining: view.daysRemaining,
    archived: record.archivedAt !== null,
    archivedAt: record.archivedAt?.toISOString() ?? null,
    version: record.version,
  };
};

const toHoldDto = (record: HoldRecord): LegalHoldDto => ({
  id: record.id,
  ruleId: record.ruleId,
  ruleName: record.ruleName,
  coveredKind: record.coveredKind,
  coveredRecordId: record.coveredRecordId,
  reason: record.reason,
  placedByUserId: record.placedByUserId,
  placedByName: record.placedByName,
  placedAt: record.placedAt.toISOString(),
  releasedAt: record.releasedAt?.toISOString() ?? null,
  releasedByUserId: record.releasedByUserId,
  releasedByName: record.releasedByName,
  releaseReason: record.releaseReason,
  active: record.releasedAt === null,
  version: record.version,
});

const toDisposalDto = (record: DisposalRecord): RetentionDisposalDto => ({
  id: record.id,
  ruleId: record.ruleId,
  ruleName: record.ruleName,
  disposedOn: dayOf(record.disposedOn),
  note: record.note,
  itemCount: record.itemCount,
  createdByUserId: record.createdByUserId,
  createdByName: record.createdByName,
  createdAt: record.createdAt.toISOString(),
});

/**
 * The retention register: the rules the organisation chose for how long it keeps records, the legal holds
 * that stop disposal, and the append-only log of disposals it carried out.
 *
 * Nothing here decides that a period is long enough or short enough: the platform knows no statutory
 * period and asserts none. Placing or lifting a hold and logging a disposal are decisions, so they need
 * `governance.approve`; reading the register and editing its text needs the ordinary data permissions.
 * The database enforces the two rules that must never be bypassed: a hold cannot be edited or deleted,
 * and no disposal is inserted while a hold on its rule is live.
 */
@Injectable()
export class RetentionService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly retention: RetentionRepository,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly requestContext: RequestContext,
  ) {}

  // ---- retention rules

  async listRules(query: ListRetentionRulesQueryDto): Promise<RetentionRulePageDto> {
    const limit = pageSizeOf(query);
    const { rows, today } = await this.uow.run(async (tx) => ({
      rows: await this.retention.listRules(tx, {
        limit,
        includeArchived: query.includeArchived === true,
        ...(query.after ? { after: query.after } : {}),
        ...(query.q ? { q: query.q } : {}),
        ...(query.classificationLevelId
          ? { classificationLevelId: query.classificationLevelId }
          : {}),
        ...(query.triggerEvent ? { triggerEvent: query.triggerEvent } : {}),
      }),
      today: await this.today(tx),
    }));
    const page = toPage(rows, limit);
    return { items: page.items.map((row) => toRuleDto(row, today)), nextCursor: page.nextCursor };
  }

  detail(id: string): Promise<RetentionRuleDetailDto> {
    return this.uow.run(async (tx) => {
      const record = await this.mustFindRule(tx, id);
      const [holds, disposals, today] = await Promise.all([
        this.retention.findLiveHoldsForRule(tx, id),
        this.retention.recentDisposalsForRule(tx, id, RECENT_DISPOSALS),
        this.today(tx),
      ]);
      return {
        ...toRuleDto(record, today),
        holds: holds.map(toHoldDto),
        recentDisposals: disposals.map(toDisposalDto),
      };
    });
  }

  async createRule(dto: CreateRetentionRuleDto): Promise<RetentionRuleDto> {
    return this.uow.run(async (tx) => {
      const fields: RuleFields = {
        name: dto.name,
        classificationLevelId: dto.classificationLevelId ?? null,
        dataCategory: dto.dataCategory ?? null,
        systemLocation: dto.systemLocation ?? null,
        triggerEvent: dto.triggerEvent ?? null,
        retentionPeriodDays: dto.retentionPeriodDays ?? null,
        gracePeriodDays: dto.gracePeriodDays ?? null,
        disposalMethod: dto.disposalMethod ?? null,
        exceptions: dto.exceptions ?? null,
        ownerMembershipId: dto.ownerMembershipId ?? null,
        lastReviewDate: dto.lastReviewDate ? utcDay(dto.lastReviewDate) : null,
        nextReviewDate: dto.nextReviewDate ? utcDay(dto.nextReviewDate) : null,
      };
      this.assertGrace(fields);
      this.assertDates(fields);
      await this.assertSubjects(tx, fields.classificationLevelId);
      await this.assertOwner(tx, fields.ownerMembershipId);
      const created = await this.retention.create(tx, fields);
      await this.audit.record(tx, {
        action: 'retention_rule.created',
        entityType: 'retention_rule',
        entityId: created.id,
        entityLabel: created.name,
        changes: {
          retentionPeriodDays: created.retentionPeriodDays,
          triggerEvent: created.triggerEvent,
        },
      });
      return toRuleDto(created, await this.today(tx));
    });
  }

  async updateRule(id: string, dto: UpdateRetentionRuleDto): Promise<RetentionRuleDto> {
    return this.uow.run(async (tx) => {
      const current = await this.mustFindRule(tx, id);
      if (current.version !== dto.version) throw versionConflict('retention rule');
      if (current.archivedAt) throw archivedConflict();

      const changes: Partial<RuleFields> = {};
      const audited: Record<string, unknown> = {};
      /**
       * Records one field in both the change set and the audit entry. Generic, so each field keeps its own
       * type instead of collapsing into a union. `asText` fields say only that they changed: they describe
       * the organisation's data, and the trail carries no description of it.
       */
      const apply = <K extends keyof RuleFields>(
        key: K,
        next: RuleFields[K] | undefined,
        asText: boolean,
      ) => {
        if (next === undefined || next === current[key]) return;
        changes[key] = next;
        audited[key] = asText ? 'changed' : { from: current[key], to: next };
      };

      apply('name', dto.name, false);
      apply('dataCategory', dto.dataCategory, true);
      apply('systemLocation', dto.systemLocation, true);
      apply('disposalMethod', dto.disposalMethod, true);
      apply('exceptions', dto.exceptions, true);
      apply('classificationLevelId', dto.classificationLevelId, false);
      apply('triggerEvent', dto.triggerEvent, false);
      apply('retentionPeriodDays', dto.retentionPeriodDays, false);
      apply('gracePeriodDays', dto.gracePeriodDays, false);
      apply('ownerMembershipId', dto.ownerMembershipId, false);

      for (const key of ['lastReviewDate', 'nextReviewDate'] as const) {
        const next = dto[key];
        if (next === undefined) continue;
        const asDate = next ? utcDay(next) : null;
        if (toDateOnly(asDate) !== toDateOnly(current[key])) {
          changes[key] = asDate;
          audited[key] = { from: toDateOnly(current[key]), to: next };
        }
      }
      if (Object.keys(changes).length === 0) return toRuleDto(current, await this.today(tx));

      // a key that IS in `changes` replaces the current value, including the null that clears it
      const eff = <K extends keyof RuleFields>(key: K): RuleFields[K] =>
        key in changes ? (changes[key] as RuleFields[K]) : current[key];

      this.assertGrace({
        retentionPeriodDays: eff('retentionPeriodDays'),
        gracePeriodDays: eff('gracePeriodDays'),
      });
      this.assertDates({
        lastReviewDate: eff('lastReviewDate'),
        nextReviewDate: eff('nextReviewDate'),
      });
      await this.assertSubjects(tx, eff('classificationLevelId'));
      if ('ownerMembershipId' in changes) await this.assertOwner(tx, eff('ownerMembershipId'));

      if (!(await this.retention.update(tx, id, dto.version, changes))) {
        throw versionConflict('retention rule');
      }
      await this.audit.record(tx, {
        action: 'retention_rule.updated',
        entityType: 'retention_rule',
        entityId: id,
        entityLabel: eff('name'),
        changes: audited,
      });
      // re-read: the joined classification level and owner names may have changed
      const fresh = await this.retention.findById(tx, id);
      return toRuleDto(fresh ?? current, await this.today(tx));
    });
  }

  /**
   * Archives the rule: no longer offered to new records, kept for the ones that still point at it.
   * Two things stop it — live processing activities that use the rule, and a live hold over it.
   */
  archiveRule(id: string, dto: RetentionRuleVersionDto): Promise<RetentionRuleDto> {
    return this.setArchived(id, dto.version, true);
  }

  unarchiveRule(id: string, dto: RetentionRuleVersionDto): Promise<RetentionRuleDto> {
    return this.setArchived(id, dto.version, false);
  }

  // ---- legal holds

  listHolds(query: ListLegalHoldsQueryDto): Promise<LegalHoldPageDto> {
    const limit = pageSizeOf(query);
    return this.uow.run(async (tx) => {
      const rows = await this.retention.listHolds(tx, {
        limit,
        ...(query.after ? { after: query.after } : {}),
        ...(query.ruleId ? { ruleId: query.ruleId } : {}),
        ...(query.state ? { state: query.state } : {}),
      });
      const page = toPage(rows, limit);
      return { items: page.items.map(toHoldDto), nextCursor: page.nextCursor };
    });
  }

  /**
   * Place a hold. The rule must be one of ours and not archived; a named record must be one of ours too,
   * and the pair (kind, record id) is either both present or both absent — a blanket hold covers the rule.
   */
  placeHold(dto: PlaceLegalHoldDto): Promise<LegalHoldDto> {
    return this.uow.run(async (tx) => {
      const rule = await this.mustFindRule(tx, dto.ruleId);
      if (rule.archivedAt) {
        throw invalid(
          'ruleId',
          'ruleArchived',
          'That retention rule is archived. Restore it or hold a live rule.',
        );
      }
      const kind = dto.coveredKind ?? null;
      const recordId = dto.coveredRecordId ?? null;
      if ((kind === null) !== (recordId === null)) {
        throw invalid(
          kind === null ? 'coveredRecordId' : 'coveredKind',
          'kindAndRecord',
          'A hold either names one record (a kind and an id) or covers the whole rule (neither).',
        );
      }
      if (kind !== null && recordId !== null) {
        const target = await this.retention.findHoldTarget(tx, kind, recordId);
        if (!target) {
          throw invalid(
            'coveredRecordId',
            'unknownRecord',
            `No ${kind} record with that id exists in this organisation.`,
          );
        }
      }

      const actorUserId = this.actorUserId();
      const hold = await this.retention.createHold(tx, {
        ruleId: rule.id,
        coveredKind: kind,
        coveredRecordId: recordId,
        reason: dto.reason,
        placedByUserId: actorUserId,
      });
      await this.audit.record(tx, {
        action: 'legal_hold.placed',
        entityType: 'legal_hold',
        entityId: hold.id,
        entityLabel: rule.name,
        changes: { ruleId: rule.id, coveredKind: kind, coveredRecordId: recordId },
      });
      return toHoldDto(hold);
    });
  }

  /**
   * Release a hold: the only write a hold ever takes. Releasing one that is already released returns it
   * unchanged, so a retry after a lost response cannot double-release.
   */
  releaseHold(id: string, dto: ReleaseLegalHoldDto): Promise<LegalHoldDto> {
    return this.uow.run(async (tx) => {
      const current = await this.mustFindHold(tx, id);
      if (current.releasedAt) return toHoldDto(current);
      if (current.version !== dto.version) throw versionConflict('legal hold');

      const releasedAt = this.clock.now();
      const releasedByUserId = this.actorUserId();
      if (
        !(await this.retention.releaseHold(tx, id, dto.version, {
          releasedAt,
          releasedByUserId,
          releaseReason: dto.reason,
        }))
      ) {
        throw versionConflict('legal hold');
      }
      await this.audit.record(tx, {
        action: 'legal_hold.released',
        entityType: 'legal_hold',
        entityId: id,
        entityLabel: current.ruleName,
        changes: { ruleId: current.ruleId },
      });
      return toHoldDto({
        ...current,
        releasedAt,
        releasedByUserId,
        releaseReason: dto.reason,
        version: current.version + 1,
      });
    });
  }

  // ---- disposal log

  listDisposals(query: ListRetentionDisposalsQueryDto): Promise<RetentionDisposalPageDto> {
    const limit = pageSizeOf(query);
    return this.uow.run(async (tx) => {
      const rows = await this.retention.listDisposals(tx, {
        limit,
        ...(query.after ? { after: query.after } : {}),
        ...(query.ruleId ? { ruleId: query.ruleId } : {}),
      });
      const page = toPage(rows, limit);
      return { items: page.items.map(toDisposalDto), nextCursor: page.nextCursor };
    });
  }

  /**
   * State that a disposal was carried out under a rule. The log is append-only and records no personal
   * data — a date, a note about the class of records, and how many. A live hold on the rule blocks it:
   * a note claiming disposal of something that must be preserved would be false.
   */
  recordDisposal(dto: RecordRetentionDisposalDto): Promise<RetentionDisposalDto> {
    return this.uow.run(async (tx) => {
      const rule = await this.mustFindRule(tx, dto.ruleId);
      if (rule.archivedAt) {
        throw invalid(
          'ruleId',
          'ruleArchived',
          'That retention rule is archived. Restore it or log the disposal under a live rule.',
        );
      }
      const today = await this.today(tx);
      if (dto.disposedOn > today) {
        throw invalid(
          'disposedOn',
          'inTheFuture',
          `A disposal is a record of what happened: it cannot be dated after today (${today}).`,
        );
      }
      if (await this.retention.hasLiveHoldOnRule(tx, rule.id)) throw disposalBlocked();

      const disposal = await this.retention.createDisposal(tx, {
        ruleId: rule.id,
        disposedOn: utcDay(dto.disposedOn),
        note: dto.note,
        itemCount: dto.itemCount ?? null,
        createdByUserId: this.actorUserId(),
      });
      await this.audit.record(tx, {
        action: 'retention_disposal.recorded',
        entityType: 'retention_disposal',
        entityId: disposal.id,
        entityLabel: rule.name,
        changes: { ruleId: rule.id, disposedOn: dto.disposedOn, itemCount: disposal.itemCount },
      });
      return toDisposalDto(disposal);
    });
  }

  // ---- the checks, all of them here and none of them in the controller

  private async setArchived(
    id: string,
    version: number,
    archived: boolean,
  ): Promise<RetentionRuleDto> {
    return this.uow.run(async (tx) => {
      const current = await this.mustFindRule(tx, id);
      if ((current.archivedAt !== null) === archived)
        return toRuleDto(current, await this.today(tx));
      if (current.version !== version) throw versionConflict('retention rule');

      if (archived) {
        const inUse = await this.retention.countLiveActivities(tx, id);
        if (inUse > 0) throw recordInUse(inUse);
        if (await this.retention.hasLiveHoldOnRule(tx, id)) throw legalHoldActive();
      }

      const archivedAt = archived ? this.clock.now() : null;
      if (!(await this.retention.update(tx, id, version, { archivedAt }))) {
        throw versionConflict('retention rule');
      }
      await this.audit.record(tx, {
        action: archived ? 'retention_rule.archived' : 'retention_rule.unarchived',
        entityType: 'retention_rule',
        entityId: id,
        entityLabel: current.name,
      });
      return toRuleDto(
        { ...current, archivedAt, version: current.version + 1 },
        await this.today(tx),
      );
    });
  }

  private async mustFindRule(tx: Tx, id: string): Promise<RuleRecord> {
    const rule = await this.retention.findById(tx, id);
    if (!rule) throw notFound('Retention rule');
    return rule;
  }

  private async mustFindHold(tx: Tx, id: string): Promise<HoldRecord> {
    const hold = await this.retention.findByIdHold(tx, id);
    if (!hold) throw notFound('Legal hold');
    return hold;
  }

  /** Today in the organisation's own zone: a review or disposal date means nothing in the server's zone. */
  private async today(tx: Tx): Promise<string> {
    return todayIn(await this.retention.timezone(tx), this.clock.now());
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

  /** The grace period is the tail of a retention period, so it needs one to hang on. */
  private assertGrace(fields: {
    retentionPeriodDays: number | null;
    gracePeriodDays: number | null;
  }): void {
    if (fields.gracePeriodDays !== null && fields.retentionPeriodDays === null) {
      throw invalid(
        'gracePeriodDays',
        'needsRetentionPeriod',
        'A grace period only means something after a retention period: set the period first.',
      );
    }
  }

  private async assertSubjects(tx: Tx, classificationLevelId: string | null): Promise<void> {
    if (!classificationLevelId) return;
    const level = await this.retention.findLevel(tx, classificationLevelId);
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
        'That classification level is archived. Restore it or choose another one.',
      );
    }
  }

  private async assertOwner(tx: Tx, ownerMembershipId: string | null): Promise<void> {
    if (!ownerMembershipId) return;
    if (!(await this.retention.findActiveMember(tx, ownerMembershipId))) {
      throw invalid(
        'ownerMembershipId',
        'notAnActiveMember',
        'The owner must be an active member of this organisation.',
      );
    }
  }

  /** The person the decision is attributed to; a hold and a disposal entry are always attributed. */
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
