import { HttpStatus, Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { AlertsService } from '../alerts/alerts.service.js';
import { Clock } from '../common/clock.js';
import { AppException, ErrorCode } from '../common/errors/app.exception.js';
import { pageSizeOf, toPage } from '../common/pagination.js';
import type { Tx } from '../database/db-client.js';
import { DeadlinePolicyService } from '../deadline-policy/deadline-policy.service.js';
import { UnitOfWork } from '../database/unit-of-work.js';
import { ASSIGNEE_RECIPIENT_LABEL } from '../domain/incidents/alerts.js';
import { effectiveLeadDays } from '../domain/incidents/deadline.js';
import {
  findReminderTransition,
  REMINDER_PREFERENCE_DEFAULTS,
  reminderDeadlineViewOf,
  REMINDER_TRANSITIONS,
  type ReminderPreferenceField,
  type ReminderStatus,
} from '../domain/incidents/reminders.js';
import { todayIn } from '../domain/remediation/policy.js';
import { roleHas, type Permission } from '../permissions/catalogue.js';
import { RequestContext } from '../tenancy/request-context.js';
import type { DeadlinePolicyRecord } from '../deadline-policy/deadline-policy.repository.js';
import type {
  ChangeReminderStatusDto,
  CreateReminderDto,
  ListRemindersQueryDto,
  ReminderDto,
  ReminderPageDto,
  ReminderPreferencesDto,
  UpdateReminderDto,
  UpdateReminderPreferencesDto,
} from './reminders.dto.js';
import {
  RemindersRepository,
  type PreferenceData,
  type ReminderCreateData,
  type ReminderPreferenceRecord,
  type ReminderRecord,
  type ReminderUpdateData,
} from './reminders.repository.js';

const notFound = (what: string) =>
  new AppException(ErrorCode.NotFound, HttpStatus.NOT_FOUND, `${what} not found.`);
const versionConflict = () =>
  new AppException(
    ErrorCode.VersionConflict,
    HttpStatus.CONFLICT,
    'This reminder was changed by someone else. Reload and try again.',
  );
const invalid = (path: string, code: string, message: string) =>
  new AppException(
    ErrorCode.ValidationFailed,
    HttpStatus.BAD_REQUEST,
    'Request validation failed.',
    [{ path, code, message }],
  );
/** A settled reminder is history: its content and its date are the record of what was owed. */
const alreadyClosed = (status: ReminderStatus) =>
  new AppException(
    ErrorCode.RecordAlreadyClosed,
    HttpStatus.CONFLICT,
    `This reminder is ${status}. A completed or cancelled reminder cannot be edited.`,
  );
/** The table lists the steps that exist; both settled statuses have none. */
const invalidTransition = (from: ReminderStatus, to: ReminderStatus) => {
  const allowed = REMINDER_TRANSITIONS.filter((step) => step.from === from).map((step) => step.to);
  return new AppException(
    ErrorCode.InvalidTransition,
    HttpStatus.CONFLICT,
    allowed.length === 0
      ? `A reminder that is ${from} has no next step: it cannot change status again.`
      : `A reminder that is ${from} can only become ${allowed.join(' or ')}, not ${to}.`,
    [{ path: 'toStatus', code: 'invalidTransition', message: `Allowed: ${allowed.join(', ')}.` }],
  );
};
/** The route cannot name two rules, so the per-row decision says it in one 403. */
const notAssignee = () =>
  new AppException(
    ErrorCode.NotAssignee,
    HttpStatus.FORBIDDEN,
    'Only someone who manages reminders, or the member this reminder is assigned to, can change it.',
  );

/** Who is asking, and what their role and their own membership allow. */
interface Caller {
  membershipId?: string;
  may: (permission: Permission) => boolean;
}

/** The two things every deadline judgement in this module needs, read once per transaction. */
interface DayContext {
  timezone: string;
  today: string;
  policy: DeadlinePolicyRecord | null;
}

const toReminderDto = (record: ReminderRecord, context: DayContext): ReminderDto => ({
  id: record.id,
  title: record.title,
  note: record.note,
  dueOn: record.dueOn,
  leadDays: record.leadDays,
  status: record.status,
  assigneeMembershipId: record.assigneeMembershipId,
  assigneeName: record.assigneeName,
  assigneeLabel: record.assigneeMembershipId === null ? null : ASSIGNEE_RECIPIENT_LABEL,
  sourceKind: record.sourceKind,
  sourceId: record.sourceId,
  sourceLabel: record.sourceLabel,
  deadline: reminderDeadlineViewOf(
    { status: record.status, dueOn: record.dueOn, leadDays: record.leadDays },
    context.today,
    context.policy?.alertLeadDays ?? null,
  ),
  createdByUserId: record.createdByUserId,
  completedOn: record.completedOn?.toISOString() ?? null,
  completedByUserId: record.completedByUserId,
  cancelledOn: record.cancelledOn?.toISOString() ?? null,
  cancelledByUserId: record.cancelledByUserId,
  cancelReason: record.cancelReason,
  createdAt: record.createdAt.toISOString(),
  updatedAt: record.updatedAt.toISOString(),
  version: record.version,
});

/** `version` here is the row's existence, not a column: `reminder_preferences` has none. */
const toPreferencesDto = (
  membershipId: string,
  record: ReminderPreferenceRecord | null,
): ReminderPreferencesDto => ({
  membershipId,
  id: record?.id ?? null,
  emailDueSoon: record?.emailDueSoon ?? REMINDER_PREFERENCE_DEFAULTS.emailDueSoon,
  emailOverdue: record?.emailOverdue ?? REMINDER_PREFERENCE_DEFAULTS.emailOverdue,
  configured: record !== null,
  savedAt: record?.updatedAt.toISOString() ?? null,
  version: record === null ? 0 : 1,
});

/**
 * The reminder ledger and each member's own email choices (AC-REMD-01).
 *
 * A reminder is a date somebody owns: it is assigned, it is settled by the assignee or by a reminder
 * manager, and it is never deleted. Its alerts are queued in the same transaction that writes the date, so
 * the promise to warn can never be out of step with the date itself. A member's choices govern only their
 * own reminder alerts — an alert an incident raises is not a preference and nothing here silences it.
 */
@Injectable()
export class RemindersService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly reminders: RemindersRepository,
    private readonly alerts: AlertsService,
    private readonly policies: DeadlinePolicyService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly requestContext: RequestContext,
  ) {}

  list(query: ListRemindersQueryDto): Promise<ReminderPageDto> {
    const limit = pageSizeOf(query);
    return this.uow.run(async (tx) => {
      const rows = await this.reminders.list(tx, {
        limit,
        ...(query.after ? { after: query.after } : {}),
        ...(query.q ? { q: query.q } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(query.sourceKind ? { sourceKind: query.sourceKind } : {}),
        ...(query.assigneeMembershipId ? { assigneeMembershipId: query.assigneeMembershipId } : {}),
        ...(query.dueBefore ? { dueBefore: query.dueBefore } : {}),
        ...(query.includeSettled === false ? { excludeSettled: true } : {}),
      });
      const context = await this.dayContext(tx);
      const page = toPage(rows, limit);
      return {
        items: page.items.map((row) => toReminderDto(row, context)),
        nextCursor: page.nextCursor,
      };
    });
  }

  get(id: string): Promise<ReminderDto> {
    return this.uow.run(async (tx) => {
      const record = await this.mustFind(tx, id);
      return toReminderDto(record, await this.dayContext(tx));
    });
  }

  /**
   * A new reminder, PENDING, with its two alerts queued beside it. The lead days the alert is judged by come
   * from the record when it sets one and from the policy otherwise, and the instant is built in the
   * organisation's own zone — an early warning at UTC midnight would arrive a day early elsewhere.
   */
  async create(dto: CreateReminderDto): Promise<ReminderDto> {
    return this.uow.run(async (tx) => {
      this.assertSourcePair(dto);
      if (dto.assigneeMembershipId) await this.activeMember(tx, dto.assigneeMembershipId);

      const context = await this.dayContext(tx);
      const leadDays = effectiveLeadDays(
        dto.leadDays ?? null,
        context.policy?.alertLeadDays ?? null,
      );
      // status is never taken from the client: the column defaults to PENDING and only the status
      // endpoint ends a reminder
      const data: ReminderCreateData = {
        title: dto.title,
        note: dto.note ?? null,
        dueOn: dto.dueOn,
        leadDays: dto.leadDays ?? null,
        assigneeMembershipId: dto.assigneeMembershipId ?? null,
        sourceKind: dto.sourceKind ?? null,
        sourceId: dto.sourceId ?? null,
        sourceLabel: dto.sourceLabel ?? null,
        createdByUserId: this.actorUserId(),
      };
      const created = await this.reminders.create(tx, data);
      await this.audit.record(tx, {
        action: 'reminder.created',
        entityType: 'reminder',
        entityId: created.id,
        entityLabel: created.title,
        // the shape of the reminder only: its text is a person's words
        changes: {
          status: created.status,
          dueOn: created.dueOn,
          leadDays,
          assigned: created.assigneeMembershipId !== null,
          sourceKind: created.sourceKind,
        },
      });
      await this.alerts.queueDeadlines(tx, {
        dueSoon: 'REMINDER_DUE_SOON',
        overdue: 'REMINDER_OVERDUE',
        source: { reminderId: created.id },
        dueOn: created.dueOn,
        leadDays,
        timezone: context.timezone,
      });
      return toReminderDto(created, context);
    });
  }

  /**
   * Content, assignee and the due date. A moved date re-queues both thresholds for the NEW day and touches
   * nothing else: the rows already queued for the old date stay, and each proves itself stale
   * (`STALE_DEADLINE`) when it runs, which is how a re-planned deadline stays auditable.
   */
  async update(id: string, dto: UpdateReminderDto): Promise<ReminderDto> {
    return this.uow.run(async (tx) => {
      const current = await this.mustFind(tx, id);
      if (current.version !== dto.version) throw versionConflict();
      if (current.status !== 'PENDING') throw alreadyClosed(current.status);
      // NOT NULL columns: a sent `null` is a refusal, never a write of null
      if (dto.title === null) {
        throw invalid('title', 'isString', 'A title is required: it cannot be cleared.');
      }
      if (dto.dueOn === null) {
        throw invalid(
          'dueOn',
          'isDateString',
          'A reminder is always due on a day: the date cannot be cleared.',
        );
      }

      const changes: ReminderUpdateData = {};
      const audited: Record<string, unknown> = {};
      if (dto.title !== undefined && dto.title !== current.title) {
        changes.title = dto.title;
        audited.title = 'changed';
      }
      if (dto.note !== undefined && dto.note !== current.note) {
        changes.note = dto.note;
        audited.note = 'changed';
      }
      if (
        dto.assigneeMembershipId !== undefined &&
        dto.assigneeMembershipId !== current.assigneeMembershipId
      ) {
        if (dto.assigneeMembershipId !== null) {
          await this.activeMember(tx, dto.assigneeMembershipId);
        }
        changes.assigneeMembershipId = dto.assigneeMembershipId;
        audited.assigneeMembershipId = 'changed';
      }
      // a moved date is the one change that re-queues: the dedupe key names the date, so the new day is a
      // new pair of alerts and the old pair stays on the ledger to be recognised as stale
      const nextDueOn = dto.dueOn;
      let movedDueOn: string | null = null;
      if (nextDueOn !== undefined && nextDueOn !== current.dueOn) {
        changes.dueOn = nextDueOn;
        audited.dueOn = { from: current.dueOn, to: nextDueOn };
        movedDueOn = nextDueOn;
      }

      if (Object.keys(changes).length === 0) {
        return toReminderDto(current, await this.dayContext(tx));
      }
      if (!(await this.reminders.update(tx, id, current.version, changes))) {
        throw versionConflict();
      }
      await this.audit.record(tx, {
        action: 'reminder.updated',
        entityType: 'reminder',
        entityId: id,
        entityLabel: changes.title ?? current.title,
        // field names only: a title and a note are a person's words
        changes: audited,
      });
      if (movedDueOn !== null) {
        const context = await this.dayContext(tx);
        await this.alerts.queueDeadlines(tx, {
          dueSoon: 'REMINDER_DUE_SOON',
          overdue: 'REMINDER_OVERDUE',
          source: { reminderId: id },
          dueOn: movedDueOn,
          leadDays: effectiveLeadDays(current.leadDays, context.policy?.alertLeadDays ?? null),
          timezone: context.timezone,
        });
      }
      const fresh = await this.reminders.findById(tx, id);
      return toReminderDto(fresh ?? current, await this.dayContext(tx));
    });
  }

  /**
   * Settle a reminder: DONE or CANCELLED, both final. The transition table alone decides whether the step
   * exists, and the row decides who may take it — the assignee, or someone who manages reminders. Nothing is
   * queued here: an alert already queued for this reminder skips itself at send time (`ALREADY_HANDLED`).
   */
  async changeStatus(id: string, dto: ChangeReminderStatusDto): Promise<ReminderDto> {
    return this.uow.run(async (tx) => {
      const current = await this.mustFind(tx, id);
      if (current.version !== dto.version) throw versionConflict();
      const transition = findReminderTransition(current.status, dto.toStatus);
      if (!transition) throw invalidTransition(current.status, dto.toStatus);
      if (!this.maySettle(current)) throw notAssignee();

      const reason = dto.reason?.trim() ?? '';
      if (transition.needsReason && reason.length < 3) {
        // `reminders_check` refuses a CANCELLED row whose reason is shorter than three characters
        throw invalid(
          'reason',
          'reasonRequired',
          'Cancelling a reminder someone was given a date for needs a reason of at least three characters: say why it is being called off.',
        );
      }

      const at = this.clock.now();
      const by = this.actorUserId();
      const changes: ReminderUpdateData =
        dto.toStatus === 'DONE'
          ? { status: 'DONE', completedOn: at, completedByUserId: by }
          : { status: 'CANCELLED', cancelledOn: at, cancelledByUserId: by, cancelReason: reason };
      if (!(await this.reminders.update(tx, id, current.version, changes))) {
        throw versionConflict();
      }
      await this.audit.record(tx, {
        action: dto.toStatus === 'DONE' ? 'reminder.completed' : 'reminder.cancelled',
        entityType: 'reminder',
        entityId: id,
        entityLabel: current.title,
        // a decision is kept with its reason; the reminder's own text is not repeated
        changes: {
          status: { from: transition.from, to: transition.to },
          ...(reason ? { reason } : {}),
        },
      });
      const fresh = await this.mustFind(tx, id);
      return toReminderDto(fresh, await this.dayContext(tx));
    });
  }

  // ---- the signed-in member's own choices

  preferences(): Promise<ReminderPreferencesDto> {
    const membershipId = this.callerMembershipId();
    return this.uow
      .run((tx) => this.reminders.findPreference(tx, membershipId))
      .then((record) => toPreferencesDto(membershipId, record));
  }

  /**
   * Save this member's own choices. The row belongs to the caller's membership, which the access guard put
   * in the request scope — a client cannot name another member. A first save creates the row (version 0),
   * every later one carries version 1 back.
   */
  async updatePreferences(dto: UpdateReminderPreferencesDto): Promise<ReminderPreferencesDto> {
    const membershipId = this.callerMembershipId();
    const fields = [
      'emailDueSoon',
      'emailOverdue',
    ] as const satisfies readonly ReminderPreferenceField[];
    for (const field of fields) {
      // both columns are NOT NULL: a `null` is a refusal, never a write of null
      if (dto[field] === null) {
        throw invalid(
          field,
          'isBoolean',
          `${field} is a choice that is on or off: it cannot be cleared.`,
        );
      }
    }

    return this.uow.run(async (tx) => {
      const current = await this.reminders.findPreference(tx, membershipId);
      if ((current === null ? 0 : 1) !== dto.version) throw versionConflict();

      const next: PreferenceData = {
        emailDueSoon:
          dto.emailDueSoon ?? current?.emailDueSoon ?? REMINDER_PREFERENCE_DEFAULTS.emailDueSoon,
        emailOverdue:
          dto.emailOverdue ?? current?.emailOverdue ?? REMINDER_PREFERENCE_DEFAULTS.emailOverdue,
      };
      const unchanged =
        current !== null &&
        current.emailDueSoon === next.emailDueSoon &&
        current.emailOverdue === next.emailOverdue;
      if (unchanged) return toPreferencesDto(membershipId, current);

      const record = current
        ? ((await this.reminders.updatePreference(tx, membershipId, next)) ?? current)
        : await this.reminders.createPreference(tx, membershipId, next);
      await this.audit.record(tx, {
        action: 'reminder.preference_updated',
        entityType: 'reminder_preference',
        entityId: record.id,
        // a choice is a boolean, not a person: the trail shows which switch moved
        changes: Object.fromEntries(
          fields
            .filter((field) => current === null || current[field] !== next[field])
            .map((field) => [field, 'changed']),
        ),
      });
      return toPreferencesDto(membershipId, record);
    });
  }

  // ---- the checks, all of them here and none of them in the controller

  private async mustFind(tx: Tx, id: string): Promise<ReminderRecord> {
    const reminder = await this.reminders.findById(tx, id);
    if (!reminder) throw notFound('Reminder');
    return reminder;
  }

  /** Today in the organisation's own zone, and the policy whose lead window a reminder falls back to. */
  private async dayContext(tx: Tx): Promise<DayContext> {
    const timezone = await this.reminders.timezone(tx);
    const policy = await this.policies.policyInForce(tx);
    return { timezone, today: todayIn(timezone, this.clock.now()), policy };
  }

  /** `source_kind`, `source_id` and the label that names the reference: a label is a note ON a source. */
  private assertSourcePair(dto: CreateReminderDto): void {
    const kind = dto.sourceKind ?? null;
    const id = dto.sourceId ?? null;
    if (kind === null && id !== null) {
      throw invalid(
        'sourceId',
        'sourceKindRequired',
        'A source id needs its kind: say what sort of record the reminder points at.',
      );
    }
    if (kind === null && (dto.sourceLabel ?? null) !== null) {
      throw invalid(
        'sourceLabel',
        'sourceKindRequired',
        'A source label needs its kind: a reference belongs to a record, not to nothing.',
      );
    }
    if (kind !== null && id === null) {
      throw invalid(
        'sourceKind',
        'sourceIdRequired',
        'A source kind needs the id of the record it points at.',
      );
    }
  }

  /** The assignee must be an ACTIVE member of this organisation. */
  private async activeMember(tx: Tx, membershipId: string): Promise<void> {
    if (!(await this.reminders.findActiveMember(tx, membershipId))) {
      throw invalid(
        'assigneeMembershipId',
        'notAnActiveMember',
        'The assignee must be an active member of this organisation.',
      );
    }
  }

  private caller(): Caller {
    const { role, membershipId } = this.requestContext.get();
    return {
      ...(membershipId ? { membershipId } : {}),
      may: (permission) => role !== undefined && roleHas(role, permission),
    };
  }

  /**
   * May this caller settle this reminder: someone who manages reminders, or the member it is assigned to.
   * The assignee is read from the row, never from what the client claims.
   */
  private maySettle(reminder: ReminderRecord, caller: Caller = this.caller()): boolean {
    if (caller.may('reminders.manage')) return true;
    return (
      caller.membershipId !== undefined && reminder.assigneeMembershipId === caller.membershipId
    );
  }

  /** The caller's own membership: what a preference row is keyed on (set by the access guard). */
  private callerMembershipId(): string {
    const membershipId = this.requestContext.get().membershipId;
    if (!membershipId) {
      throw new AppException(
        ErrorCode.InternalError,
        HttpStatus.INTERNAL_SERVER_ERROR,
        'No membership for this request.',
      );
    }
    return membershipId;
  }

  /** The person the decision is attributed to; every reminder column is attributed. */
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
