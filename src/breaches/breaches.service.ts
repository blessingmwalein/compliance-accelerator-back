import { HttpStatus, Injectable } from '@nestjs/common';
import { AlertsService } from '../alerts/alerts.service.js';
import { AuditService } from '../audit/audit.service.js';
import { Clock } from '../common/clock.js';
import type { DeadlineViewDto } from '../common/deadline-view.js';
import { AppException, ErrorCode } from '../common/errors/app.exception.js';
import { pageSizeOf, toPage } from '../common/pagination.js';
import type { Tx } from '../database/db-client.js';
import { UnitOfWork } from '../database/unit-of-work.js';
import { DeadlinePolicyService } from '../deadline-policy/deadline-policy.service.js';
import {
  breachClosureBlock,
  breachDeadlineStates,
  detectedInCalendarYear,
  findBreachTransition,
  isWorkingBreachStatus,
  nextBreachStatuses,
  notificationStateOfDecision,
  type BreachNotificationDecisionKind,
  type BreachNotificationState,
  type BreachStatus,
} from '../domain/incidents/breach.js';
import {
  alertInstantOn,
  deadlineViewOf,
  type DeadlineState,
} from '../domain/incidents/deadline.js';
import { breachScheduleOf } from '../domain/incidents/policy.js';
import { toDateOnly, utcDay } from '../domain/registers/review.js';
import { todayIn } from '../domain/remediation/policy.js';
import { roleHas, type Permission } from '../permissions/catalogue.js';
import { RequestContext } from '../tenancy/request-context.js';
import type {
  AddBreachChronologyDto,
  BreachChronologyEntryDto,
  BreachDetailDto,
  BreachDto,
  BreachEvidenceDto,
  BreachNotificationDecisionDto,
  BreachPageDto,
  BreachStatusTransitionDto,
  BreachSummaryDto,
  ChangeBreachStatusDto,
  CreateBreachDto,
  ListBreachesQueryDto,
  RecordBreachDecisionDto,
  UpdateBreachDto,
} from './breaches.dto.js';
import {
  BreachesRepository,
  type BreachChanges,
  type BreachFields,
  type BreachRecord,
  type ChronologyRecord,
  type DecisionRecord,
} from './breaches.repository.js';

const notFound = (what: string) =>
  new AppException(ErrorCode.NotFound, HttpStatus.NOT_FOUND, `${what} not found.`);
const versionConflict = () =>
  new AppException(
    ErrorCode.VersionConflict,
    HttpStatus.CONFLICT,
    'This breach was changed by someone else. Reload and try again.',
  );
/** A closed breach is the end of the lifecycle: its content, timeline and ledger stop accepting work. */
const alreadyClosed = () =>
  new AppException(
    ErrorCode.RecordAlreadyClosed,
    HttpStatus.CONFLICT,
    'This breach is closed. Its record is complete: nothing further changes on it.',
  );
/** Closing needs a notification decision on the ledger first (AC-BRC-01); the trigger says the same. */
const decisionRequired = () =>
  new AppException(
    ErrorCode.BreachDecisionRequired,
    HttpStatus.UNPROCESSABLE_ENTITY,
    'Record the notification decision before closing this breach: whether the authority is to be told, and why.',
  );
const invalidTransition = (from: BreachStatus, allowed: readonly BreachStatus[]) =>
  new AppException(
    ErrorCode.InvalidTransition,
    HttpStatus.CONFLICT,
    allowed.length === 0
      ? `A breach that is ${from} cannot change status.`
      : `A breach that is ${from} can only become ${allowed.join(', ')}.`,
    [{ path: 'toStatus', code: 'invalidTransition', message: `Allowed: ${allowed.join(', ')}.` }],
  );
const invalid = (path: string, code: string, message: string) =>
  new AppException(
    ErrorCode.ValidationFailed,
    HttpStatus.BAD_REQUEST,
    'Request validation failed.',
    [{ path, code, message }],
  );
const forbidden = (what: string) =>
  new AppException(ErrorCode.Forbidden, HttpStatus.FORBIDDEN, `Only an approver can ${what}.`);
/** The breach model links a business unit and an owner; there is no governance area to point at. */
const unknown = (path: string, what: string) =>
  invalid(path, `unknown${path.charAt(0).toUpperCase()}${path.slice(1)}`, what);

/** The caller's role, as the one rule this service needs. */
interface Caller {
  may: (permission: Permission) => boolean;
}

/** The breach columns a deadline view is read from, as the domain states them. */
interface DeadlineSource {
  status: BreachStatus;
  assessmentDueOn: string | null;
  notificationDueOn: string | null;
  notificationState: BreachNotificationState;
}

/** The stored row's dates as the organisation's calendar days: the domain compares days, never instants. */
const asDuty = (row: {
  status: BreachStatus;
  assessmentDueOn: Date | null;
  notificationDueOn: Date | null;
  notificationState: BreachNotificationState;
}): DeadlineSource => ({
  status: row.status,
  assessmentDueOn: toDateOnly(row.assessmentDueOn),
  notificationDueOn: toDateOnly(row.notificationDueOn),
  notificationState: row.notificationState,
});

/**
 * The personal data breach registry (AC-BRC-01, AC-BRC-02). Detection, containment and remediation are
 * chronology entries, so the status only tracks the phase and the timeline carries the steps.
 *
 * The two deadlines are frozen onto the row when it is created, from the policy in force at that moment:
 * a later change to the policy cannot rewrite a deadline that was already running, and the database CHECK
 * refuses a row whose dates stop matching its own day counts. Nothing here deletes a breach.
 */
@Injectable()
export class BreachesService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly breaches: BreachesRepository,
    private readonly audit: AuditService,
    private readonly alerts: AlertsService,
    private readonly policies: DeadlinePolicyService,
    private readonly clock: Clock,
    private readonly requestContext: RequestContext,
  ) {}

  /**
   * The three numbers the registry exists to give. `overdue` counts only undecided duties, so a breach
   * whose duty was answered on time is never counted late, and it counts only where a window was configured.
   */
  async summary(): Promise<BreachSummaryDto> {
    return this.uow.run(async (tx) => {
      const [rows, policy, today] = await Promise.all([
        this.breaches.aggregateRows(tx),
        this.policies.policyInForce(tx),
        this.today(tx),
      ]);
      const leadDays = policy?.alertLeadDays ?? null;
      return {
        open: rows.filter((row) => isWorkingBreachStatus(row.status)).length,
        annualTotal: rows.filter((row) =>
          detectedInCalendarYear(toDateOnly(row.detectedOn) ?? '', today),
        ).length,
        overdue: rows.filter(
          (row) => breachDeadlineStates(asDuty(row), today, leadDays).notification === 'overdue',
        ).length,
        // nothing can fall late without a window to be late against, and no policy is not an error
        notificationConfigured: policy?.breachNotificationDays != null,
        today,
      };
    });
  }

  async list(query: ListBreachesQueryDto): Promise<BreachPageDto> {
    const limit = pageSizeOf(query);
    return this.uow.run(async (tx) => {
      const rows = await this.breaches.list(tx, {
        limit,
        ...(query.after ? { after: query.after } : {}),
        ...(query.q ? { q: query.q } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(query.notificationState ? { notificationState: query.notificationState } : {}),
        ...(query.businessUnitId ? { businessUnitId: query.businessUnitId } : {}),
        ...(query.ownerMembershipId ? { ownerMembershipId: query.ownerMembershipId } : {}),
        ...(query.dueBefore ? { dueBefore: query.dueBefore } : {}),
        ...(query.includeClosed === false ? { excludeClosed: true } : {}),
      });
      const page = toPage(rows, limit);
      const [today, leadDays] = await Promise.all([this.today(tx), this.leadDays(tx)]);
      return {
        items: page.items.map((row) => this.toDto(row, today, leadDays)),
        nextCursor: page.nextCursor,
      };
    });
  }

  detail(id: string): Promise<BreachDetailDto> {
    return this.uow.run(async (tx) => this.detailIn(tx, await this.mustFind(tx, id)));
  }

  /**
   * Record a breach. The windows come from the policy in force THIS moment and are copied onto the row
   * together with the dates they produce; the status is RECORDED and the notification duty UNDECIDED,
   * because nothing has been assessed yet and no absence is a decision.
   */
  async create(dto: CreateBreachDto): Promise<BreachDetailDto> {
    return this.uow.run(async (tx) => {
      const [policy, timezone] = await Promise.all([
        this.policies.policyInForce(tx),
        this.breaches.timezone(tx),
      ]);
      await this.assertSubjects(tx, {
        businessUnitId: dto.businessUnitId ?? null,
        ownerMembershipId: dto.ownerMembershipId ?? null,
      });

      const schedule = breachScheduleOf(policy, dto.detectedOn);
      const created = await this.breaches.create(
        tx,
        {
          title: dto.title,
          description: dto.description ?? null,
          affectedData: dto.affectedData ?? null,
          affectedSubjectCount: dto.affectedSubjectCount ?? null,
          severity: dto.severity ?? null,
          impact: dto.impact ?? null,
          businessUnitId: dto.businessUnitId ?? null,
          ownerMembershipId: dto.ownerMembershipId ?? null,
          detectedOn: utcDay(dto.detectedOn),
          policyId: schedule.policyId,
          assessmentDays: schedule.assessmentDays,
          notificationDays: schedule.notificationDays,
          assessmentDueOn:
            schedule.assessmentDueOn === null ? null : utcDay(schedule.assessmentDueOn),
          notificationDueOn:
            schedule.notificationDueOn === null ? null : utcDay(schedule.notificationDueOn),
        },
        this.actorUserId(),
      );
      await this.audit.record(tx, {
        action: 'breach.created',
        entityType: 'breach',
        entityId: created.id,
        entityLabel: created.title,
        // the record's free text stays out of the trail; the dates and the windows are the facts to keep
        changes: {
          status: created.status,
          detectedOn: dto.detectedOn,
          policyId: schedule.policyId,
          assessmentDays: schedule.assessmentDays,
          notificationDays: schedule.notificationDays,
          assessmentDueOn: schedule.assessmentDueOn,
          notificationDueOn: schedule.notificationDueOn,
        },
      });

      // the duty is raised the moment it exists; the two dated duties queue their own morning alert
      await this.alerts.queue(
        tx,
        { kind: 'BREACH_RECORDED', source: { breachId: created.id }, dueOn: null },
        this.clock.now(),
      );
      if (schedule.assessmentDueOn !== null) {
        await this.alerts.queue(
          tx,
          {
            kind: 'BREACH_ASSESSMENT_DUE',
            source: { breachId: created.id },
            dueOn: schedule.assessmentDueOn,
          },
          alertInstantOn(schedule.assessmentDueOn, timezone),
        );
      }
      if (schedule.notificationDueOn !== null) {
        await this.alerts.queue(
          tx,
          {
            kind: 'BREACH_NOTIFICATION_DUE',
            source: { breachId: created.id },
            dueOn: schedule.notificationDueOn,
          },
          alertInstantOn(schedule.notificationDueOn, timezone),
        );
      }
      return this.detailIn(tx, created);
    });
  }

  /** The registry's content. Status, deadlines and decisions are not edited here. */
  async update(id: string, dto: UpdateBreachDto): Promise<BreachDto> {
    return this.uow.run(async (tx) => {
      const current = await this.mustFind(tx, id);
      if (current.version !== dto.version) throw versionConflict();
      if (current.status === 'CLOSED') throw alreadyClosed();

      const changes: BreachChanges = {};
      const audited: Record<string, unknown> = {};
      /**
       * Records one field in the change set and its audit entry. `asText` fields say only that they
       * changed: a breach's own words are personal data and do not belong in the trail (AC-BRC-02).
       */
      const apply = <K extends keyof BreachChanges>(
        key: K,
        next: BreachChanges[K] | undefined,
        asText: boolean,
      ) => {
        if (next === undefined || next === current[key]) return;
        changes[key] = next;
        audited[key] = asText ? 'changed' : { from: current[key], to: next };
      };

      apply('title', dto.title, true);
      apply('description', dto.description, true);
      apply('affectedData', dto.affectedData, true);
      apply('impact', dto.impact, true);
      apply('affectedSubjectCount', dto.affectedSubjectCount, false);
      apply('severity', dto.severity, false);
      apply('businessUnitId', dto.businessUnitId, false);
      apply('ownerMembershipId', dto.ownerMembershipId, false);

      if (Object.keys(changes).length === 0) {
        const [today, leadDays] = await Promise.all([this.today(tx), this.leadDays(tx)]);
        return this.toDto(current, today, leadDays);
      }

      await this.assertSubjects(tx, changes);
      if (!(await this.breaches.update(tx, id, dto.version, changes))) throw versionConflict();
      await this.audit.record(tx, {
        action: 'breach.updated',
        entityType: 'breach',
        entityId: id,
        entityLabel: changes.title ?? current.title,
        changes: audited,
      });
      // re-read: the joined names are the row's, not this request's
      const fresh = await this.breaches.findById(tx, id);
      const [today, leadDays] = await Promise.all([this.today(tx), this.leadDays(tx)]);
      return this.toDto(fresh ?? current, today, leadDays);
    });
  }

  /**
   * One step along the lifecycle. The steps between the working phases belong to whoever works the case;
   * closing belongs to an approver, needs the outcome in words, and needs a notification decision already
   * on the ledger. There is no step back out of CLOSED.
   */
  async changeStatus(id: string, dto: ChangeBreachStatusDto): Promise<BreachDetailDto> {
    return this.uow.run(async (tx) => {
      const current = await this.mustFind(tx, id);
      if (current.version !== dto.version) throw versionConflict();
      if (dto.toStatus === current.status) {
        throw invalid('toStatus', 'unchanged', `This breach is already ${current.status}.`);
      }
      const transition = findBreachTransition(current.status, dto.toStatus);
      if (!transition) {
        throw invalidTransition(
          current.status,
          nextBreachStatuses(current.status).map((step) => step.to),
        );
      }
      this.assertMayTake(transition.by, transition.from, transition.to);

      const closing = dto.toStatus === 'CLOSED';
      const reason = dto.reason?.trim() ?? '';
      if (transition.needsReason && reason === '') {
        throw invalid(
          'reason',
          'reasonRequired',
          'Closing a breach needs its outcome in words: say how it ended.',
        );
      }
      // the CHECK keeps a closure note of at least three characters: one word is not an outcome
      if (closing && reason.length < 3) {
        throw invalid(
          'reason',
          'reasonTooShort',
          'Say what the closure means in at least a few characters.',
        );
      }
      const block = breachClosureBlock(dto.toStatus, await this.breaches.hasDecisions(tx, id));
      if (block === 'no_decision') throw decisionRequired();

      const today = await this.today(tx);
      if (closing) {
        const detectedOn = toDateOnly(current.detectedOn);
        // the CHECK refuses a closure dated before the detection it closed; that is a wrong day, not a bug
        if (detectedOn !== null && today < detectedOn) {
          throw invalid(
            'toStatus',
            'closedBeforeDetection',
            `This breach is recorded as detected on ${detectedOn}, later than today (${today}), so it cannot be closed yet.`,
          );
        }
      }
      const changes: BreachChanges = { status: dto.toStatus };
      if (closing) {
        changes.closedOn = utcDay(today);
        changes.closedByUserId = this.actorUserId();
        changes.closureNote = reason;
      }
      if (!(await this.breaches.update(tx, id, dto.version, changes))) throw versionConflict();

      await this.audit.record(tx, {
        action: 'breach.status_changed',
        entityType: 'breach',
        entityId: id,
        entityLabel: current.title,
        changes: {
          status: { from: transition.from, to: transition.to },
          ...(reason === '' ? {} : { reason }),
        },
      });
      return this.detailIn(tx, await this.mustFind(tx, id));
    });
  }

  /** Append one event to the timeline. A step that happened twice is written twice, and nothing edits one. */
  async addChronology(id: string, dto: AddBreachChronologyDto): Promise<BreachDetailDto> {
    return this.uow.run(async (tx) => {
      const current = await this.mustFind(tx, id);
      await this.breaches.createChronology(tx, {
        breachId: current.id,
        kind: dto.kind,
        occurredOn: utcDay(dto.occurredOn),
        note: dto.note,
        createdByUserId: this.actorUserId(),
      });
      await this.audit.record(tx, {
        action: 'breach.chronology_added',
        entityType: 'breach',
        entityId: id,
        entityLabel: current.title,
        // what happened is the note, and the note is breach detail: the trail records that it was written
        changes: { kind: dto.kind, occurredOn: dto.occurredOn },
      });
      return this.detailIn(tx, current);
    });
  }

  /**
   * Record the notification decision. The ledger is append-only, so a second decision adds a row and keeps
   * the first; the duty's state comes from the decision the domain maps it to, never from the client, and
   * moves with the breach row so the trigger can check the pair.
   */
  async recordDecision(id: string, dto: RecordBreachDecisionDto): Promise<BreachDetailDto> {
    return this.uow.run(async (tx) => {
      const current = await this.mustFind(tx, id);
      if (current.version !== dto.version) throw versionConflict();
      // the trigger refuses a decision on a closed breach: what is known about it is fixed
      if (current.status === 'CLOSED') throw alreadyClosed();

      const notifying = dto.decision === 'REQUIRED';
      const regulatorContactId = dto.regulatorContactId ?? null;
      const authorityName = dto.authorityName ?? null;
      const targetDate = dto.targetDate ?? null;
      this.assertDecisionPair({ notifying, regulatorContactId, authorityName, targetDate });
      if (
        regulatorContactId !== null &&
        !(await this.breaches.findRegulator(tx, regulatorContactId))
      ) {
        throw unknown(
          'regulatorContactId',
          'The regulator contact does not exist in this organisation.',
        );
      }

      const notificationState = notificationStateOfDecision(dto.decision);
      await this.breaches.createDecision(tx, {
        breachId: current.id,
        decision: dto.decision,
        regulatorContactId,
        authorityName,
        targetDate: targetDate === null ? null : utcDay(targetDate),
        reason: dto.reason,
        decidedByUserId: this.actorUserId(),
      });
      if (
        !(await this.breaches.update(tx, id, dto.version, {
          notificationState,
        }))
      ) {
        throw versionConflict();
      }
      await this.audit.record(tx, {
        action: 'breach.decision_recorded',
        entityType: 'breach',
        entityId: id,
        entityLabel: current.title,
        // a decision is kept with its reason: the trail has to answer what was decided, not that something was
        changes: {
          status: { from: current.notificationState, to: notificationState },
          decision: dto.decision,
          authorityName,
          regulatorContactId,
          targetDate,
          reason: dto.reason,
        },
      });
      // no alert is queued or touched here: a decided duty makes its own queued alert skip itself at send time
      return this.detailIn(tx, await this.mustFind(tx, id));
    });
  }

  /** Attach an evidence file of this organisation. A second link of the same file changes nothing. */
  async linkEvidence(id: string, evidenceId: string): Promise<BreachDetailDto> {
    return this.uow.run(async (tx) => {
      const current = await this.mustFind(tx, id);
      const [evidence] = await this.breaches.findEvidence(tx, [evidenceId]);
      if (!evidence) throw notFound('Evidence');
      if (await this.breaches.findLink(tx, current.id, evidenceId)) {
        throw new AppException(
          ErrorCode.Conflict,
          HttpStatus.CONFLICT,
          'This evidence file is already attached to the breach.',
        );
      }
      await this.breaches.createLink(tx, {
        breachId: current.id,
        evidenceId,
        linkedByUserId: this.actorUserId(),
      });
      await this.audit.record(tx, {
        action: 'breach.evidence_linked',
        entityType: 'breach',
        entityId: id,
        entityLabel: current.title,
        changes: { evidenceId, evidenceTitle: evidence.title },
      });
      return this.detailIn(tx, current);
    });
  }

  /** Detach the link; the file itself stays in the evidence repository. */
  async unlinkEvidence(id: string, evidenceId: string): Promise<void> {
    return this.uow.run(async (tx) => {
      const current = await this.mustFind(tx, id);
      if (!(await this.breaches.deleteLink(tx, current.id, evidenceId))) {
        throw notFound('Evidence link');
      }
      await this.audit.record(tx, {
        action: 'breach.evidence_unlinked',
        entityType: 'breach',
        entityId: id,
        entityLabel: current.title,
        changes: { evidenceId },
      });
    });
  }

  // ---- the checks, all of them here and none of them in the controller

  private caller(): Caller {
    const { role } = this.requestContext.get();
    return { may: (permission) => role !== undefined && roleHas(role, permission) };
  }

  private assertMayTake(by: 'work' | 'approve', from: BreachStatus, to: BreachStatus): void {
    if (by === 'approve') {
      if (!this.caller().may('governance.approve')) {
        throw forbidden(`move a breach from ${from} to ${to}`);
      }
      return;
    }
    if (!this.caller().may('governance.edit')) {
      throw new AppException(
        ErrorCode.Forbidden,
        HttpStatus.FORBIDDEN,
        'Only someone who may edit the breach registry can take this step.',
      );
    }
  }

  /**
   * The three pairings the `breach_decisions_check` writes: a decision to notify names a date and exactly
   * one authority, a decision not to notify names neither.
   */
  private assertDecisionPair(args: {
    notifying: boolean;
    regulatorContactId: string | null;
    authorityName: string | null;
    targetDate: string | null;
  }): void {
    if (!args.notifying) {
      if (args.targetDate !== null) {
        throw invalid(
          'targetDate',
          'notApplicable',
          'A decision that notification is not required has no date to notify by.',
        );
      }
      if (args.regulatorContactId !== null || args.authorityName !== null) {
        throw invalid(
          'authorityName',
          'notApplicable',
          'A decision that notification is not required names no authority.',
        );
      }
      return;
    }
    if (args.targetDate === null) {
      throw invalid(
        'targetDate',
        'targetDateRequired',
        'A decision to notify names the day the notification is to be made by.',
      );
    }
    const named = Number(args.regulatorContactId !== null) + Number(args.authorityName !== null);
    if (named !== 1) {
      throw invalid(
        'authorityName',
        'authorityRequired',
        'A decision to notify names exactly one authority: one from the regulator list, or one written here.',
      );
    }
  }

  private async assertSubjects(tx: Tx, fields: Partial<BreachFields>): Promise<void> {
    if (
      fields.businessUnitId &&
      !(await this.breaches.findBusinessUnit(tx, fields.businessUnitId))
    ) {
      throw unknown('businessUnitId', 'The business unit does not exist in this organisation.');
    }
    if (fields.ownerMembershipId) {
      if (!(await this.breaches.findActiveMember(tx, fields.ownerMembershipId))) {
        throw invalid(
          'ownerMembershipId',
          'notAnActiveMember',
          'The owner must be an active member of this organisation.',
        );
      }
    }
  }

  private async mustFind(tx: Tx, id: string): Promise<BreachRecord> {
    const breach = await this.breaches.findById(tx, id);
    if (!breach) throw notFound('Breach');
    return breach;
  }

  /** The person a decision is attributed to: a closure, a decision and a link are always someone's. */
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

  /** Today in the organisation's own zone: a deadline means nothing in the server's zone. */
  private async today(tx: Tx): Promise<string> {
    return todayIn(await this.breaches.timezone(tx), this.clock.now());
  }

  /** The early-warning window the breach rows are judged by; the policy is the only holder of it. */
  private async leadDays(tx: Tx): Promise<number | null> {
    const policy = await this.policies.policyInForce(tx);
    return policy?.alertLeadDays ?? null;
  }

  private async detailIn(tx: Tx, record: BreachRecord): Promise<BreachDetailDto> {
    const [chronology, decisions, evidence, today, leadDays] = await Promise.all([
      this.breaches.listChronology(tx, record.id),
      this.breaches.listDecisions(tx, record.id),
      this.breaches.listEvidence(tx, record.id),
      this.today(tx),
      this.leadDays(tx),
    ]);
    return {
      ...this.toDto(record, today, leadDays),
      chronology: chronology.map(toChronologyDto),
      decisions: decisions.map((row) => toDecisionDto(row, notificationStateOfDecision)),
      evidence: evidence.map<BreachEvidenceDto>((row) => ({
        evidenceId: row.evidenceId,
        title: row.title,
        currentVersion: row.currentVersion,
        linkedAt: row.linkedAt.toISOString(),
      })),
      decisionRecorded: decisions.length > 0,
    };
  }

  /** The steps THIS caller can take now, so the UI never offers a forbidden one. */
  private allowedTransitions(status: BreachStatus): BreachStatusTransitionDto[] {
    const caller = this.caller();
    return nextBreachStatuses(status)
      .filter((step) =>
        step.by === 'approve' ? caller.may('governance.approve') : caller.may('governance.edit'),
      )
      .map(({ to, by, needsReason }) => ({ toStatus: to, by, needsReason }));
  }

  private toDto(record: BreachRecord, today: string, leadDays: number | null) {
    const source = asDuty(record);
    // the state is the domain's, settled once the record is closed; the day beside it is the plain view's
    const states = breachDeadlineStates(source, today, leadDays);
    const view = (dueOn: string | null, state: DeadlineState): DeadlineViewDto => ({
      ...deadlineViewOf(dueOn, today, leadDays),
      state,
    });
    return {
      id: record.id,
      title: record.title,
      description: record.description,
      status: record.status,
      detectedOn: toDateOnly(record.detectedOn) ?? '',
      affectedData: record.affectedData,
      affectedSubjectCount: record.affectedSubjectCount,
      severity: record.severity,
      impact: record.impact,
      businessUnitId: record.businessUnitId,
      businessUnitName: record.businessUnitName,
      ownerMembershipId: record.ownerMembershipId,
      ownerName: record.ownerName,
      policyId: record.policyId,
      assessmentDays: record.assessmentDays,
      notificationDays: record.notificationDays,
      assessmentDeadline: view(source.assessmentDueOn, states.assessment),
      notificationDeadline: view(source.notificationDueOn, states.notification),
      notificationState: record.notificationState,
      notificationSettled: record.notificationState !== 'UNDECIDED',
      closedOn: toDateOnly(record.closedOn),
      closedByUserId: record.closedByUserId,
      closureNote: record.closureNote,
      createdByUserId: record.createdByUserId,
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
      version: record.version,
      allowedTransitions: this.allowedTransitions(record.status),
    };
  }
}

/** The ledger row and the state it left the duty in: the mapping is the domain's, not the client's. */
const toDecisionDto = (
  row: DecisionRecord,
  stateOf: (kind: BreachNotificationDecisionKind) => BreachNotificationState,
): BreachNotificationDecisionDto => ({
  id: row.id,
  breachId: row.breachId,
  decision: row.decision,
  notificationState: stateOf(row.decision),
  regulatorContactId: row.regulatorContactId,
  regulatorAuthorityName: row.regulatorAuthorityName,
  authorityName: row.authorityName,
  targetDate: toDateOnly(row.targetDate),
  reason: row.reason,
  decidedByUserId: row.decidedByUserId,
  decidedByName: row.decidedByName,
  decidedAt: row.decidedAt.toISOString(),
});

const toChronologyDto = (row: ChronologyRecord): BreachChronologyEntryDto => ({
  id: row.id,
  breachId: row.breachId,
  kind: row.kind,
  occurredOn: toDateOnly(row.occurredOn) ?? '',
  note: row.note,
  createdByUserId: row.createdByUserId,
  createdByName: row.createdByName,
  createdAt: row.createdAt.toISOString(),
});
