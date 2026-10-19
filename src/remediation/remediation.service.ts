import { HttpStatus, Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { Clock } from '../common/clock.js';
import { AppException, ErrorCode } from '../common/errors/app.exception.js';
import { pageSizeOf, toPage } from '../common/pagination.js';
import { UnitOfWork } from '../database/unit-of-work.js';
import type { Tx } from '../database/db-client.js';
import {
  dueDateFor,
  findTransition,
  nextStatuses,
  priorityForRisk,
  todayIn,
  type TaskStatus,
  type Transition,
} from '../domain/remediation/policy.js';
import { roleHas, type Permission } from '../permissions/catalogue.js';
import type { DueDays } from '../scoring/scoring.service.js';
import { ScoringService } from '../scoring/scoring.service.js';
import { RequestContext } from '../tenancy/request-context.js';
import type {
  ChangeRemediationTaskStatusDto,
  CommentRemediationTaskDto,
  CreateRemediationTaskDto,
  GenerateRemediationTasksDto,
  GeneratedRemediationTasksDto,
  GeneratedTaskSkipDto,
  ListRemediationTasksQueryDto,
  RemediationTaskDetailDto,
  RemediationTaskDto,
  RemediationTaskEventDto,
  RemediationTaskPageDto,
  TaskTransitionDto,
  UpdateRemediationTaskDto,
} from './remediation.dto.js';
import {
  RemediationRepository,
  snapshotOf,
  type AssessmentRecord,
  type GapItemRecord,
  type TaskCreateData,
  type TaskItemRatings,
  type TaskRecord,
  type TaskUpdateData,
} from './remediation.repository.js';
import {
  RemediationTimelineRepository,
  type EventRecord,
} from './remediation-timeline.repository.js';

const notFound = (what: string) =>
  new AppException(ErrorCode.NotFound, HttpStatus.NOT_FOUND, `${what} not found.`);
const versionConflict = () =>
  new AppException(
    ErrorCode.VersionConflict,
    HttpStatus.CONFLICT,
    'This task was changed by someone else. Reload and try again.',
  );
const invalid = (path: string, code: string, message: string) =>
  new AppException(
    ErrorCode.ValidationFailed,
    HttpStatus.BAD_REQUEST,
    'Request validation failed.',
    [{ path, code, message }],
  );

/** The only two 403s this module gives: the caller is neither an editor nor the assignee. */
const notAssignee = () =>
  new AppException(
    ErrorCode.NotAssignee,
    HttpStatus.FORBIDDEN,
    'Only an editor of remediation work, or the member this task is assigned to, can change it.',
  );

/** 409 with the moves that ARE possible spelled out, so the caller never has to guess the lifecycle. */
const invalidTransition = (from: TaskStatus, to: TaskStatus, allowed: readonly TaskStatus[]) =>
  new AppException(
    ErrorCode.InvalidTransition,
    HttpStatus.CONFLICT,
    `A task that is ${from} cannot go straight to ${to}. From ${from} it can move to: ` +
      (allowed.length > 0 ? allowed.join(', ') : 'nowhere — the status has no next step.') +
      ' A change of status is only allowed through the steps of the task lifecycle.',
  );

const reopenNeedsReason = (to: TaskStatus) =>
  new AppException(
    ErrorCode.InvalidTransition,
    HttpStatus.CONFLICT,
    `Moving a task to ${to} reopens finished work, so it needs a reason: say why it is starting again.`,
  );

/** The calendar day of a DATE column value (`YYYY-MM-DD`), read in UTC: never shifted by the host zone. */
const toDateOnly = (value: Date | null): string | null =>
  value === null
    ? null
    : `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, '0')}-${String(
        value.getUTCDate(),
      ).padStart(2, '0')}`;

/** A calendar day as the instant Prisma writes into a DATE column (UTC midnight; the adapter sends the day). */
const utcDay = (date: string): Date => new Date(`${date}T00:00:00.000Z`);

/**
 * The due-date state of one task, decided against the organisation's calendar day. A task with no due
 * date gets `no_due_date` and carries NO verdict at all: an absent deadline is not "on time"
 * (skill grc-domain, section 3 — missing data is never a result).
 *
 * The return type is left to inference on purpose: `TaskDueStateDto`'s `isOverdue` / `dueDate` are absent
 * for a task with no due date, so the shape is deliberately narrower than the DTO — and spreading the
 * result into a row keeps that narrower shape instead of widening it back to "maybe undefined".
 */
function dueStateOf(dueDate: Date | null, today: string) {
  const day = toDateOnly(dueDate);
  if (day === null) return { availability: 'no_due_date' as const, asOf: today };
  // Both sides are YYYY-MM-DD, so comparing the strings compares the calendar days.
  return { availability: 'ok' as const, isOverdue: day < today, dueDate: day, asOf: today };
}

const toEventDto = (event: EventRecord): RemediationTaskEventDto => ({
  id: event.id,
  kind: event.kind,
  fromStatus: event.fromStatus,
  toStatus: event.toStatus,
  body: event.body,
  actorUserId: event.actorUserId,
  actorName: event.actorName,
  createdAt: event.createdAt.toISOString(),
});

/**
 * The list row's fields. Its type is inferred (an object, not a `RemediationTaskDto` instance) so the
 * detail below can build on it without pretending to copy a class prototype; `toTaskDto` is what pins the
 * shape to the documented DTO.
 */
const taskFieldsOf = (record: TaskRecord, today: string) => ({
  id: record.id,
  title: record.title,
  description: record.description,
  priority: record.priority,
  status: record.status,
  assigneeMembershipId: record.assigneeMembershipId,
  assigneeName: record.assigneeName,
  dueDate: toDateOnly(record.dueDate),
  dueState: dueStateOf(record.dueDate, today),
  autoGenerated: record.autoGenerated,
  assessmentItemId: record.assessmentItemId,
  governanceAreaId: record.governanceAreaId,
  governanceAreaName: record.governanceAreaName,
  requirementId: record.requirementId,
  requirementRef: record.requirementRef,
  requirementTitle: record.requirementTitle,
  businessUnitId: record.businessUnitId,
  businessUnitName: record.businessUnitName,
  frameworkId: record.frameworkId,
  frameworkCode: record.frameworkCode,
  createdAt: record.createdAt.toISOString(),
  updatedAt: record.updatedAt.toISOString(),
  version: record.version,
});

/** A list row: the task, its subject names, and the server's due-date verdict. */
const toTaskDto = (record: TaskRecord, today: string): RemediationTaskDto =>
  taskFieldsOf(record, today);

/** The detail adds the snapshot the task was raised for, the timeline, the evidence ids and the caller's moves. */
const toDetailDto = (
  record: TaskRecord,
  today: string,
  events: RemediationTaskEventDto[],
  evidenceIds: string[],
  allowedTransitions: TaskTransitionDto[],
): RemediationTaskDetailDto => ({
  ...taskFieldsOf(record, today),
  snapshotCurrentMaturity: record.snapshotCurrentMaturity,
  snapshotTargetMaturity: record.snapshotTargetMaturity,
  snapshotGap: record.snapshotGap,
  snapshotRiskLevel: record.snapshotRiskLevel,
  createdByUserId: record.createdByUserId,
  completedAt: record.completedAt?.toISOString() ?? null,
  completedByUserId: record.completedByUserId,
  verifiedAt: record.verifiedAt?.toISOString() ?? null,
  verifiedByUserId: record.verifiedByUserId,
  events,
  evidenceIds,
  allowedTransitions,
});

/**
 * A generated task's title, built from the subject's own names (the area, the requirement's identifier,
 * the unit, the framework). Nothing is invented: these are the organisation's words and the pack's titles.
 */
function titleFor(item: GapItemRecord): string {
  const subject = [
    item.governanceAreaName,
    item.requirementRef ?? item.requirementTitle,
    item.businessUnitName,
    item.frameworkCode,
  ]
    .filter((part): part is string => typeof part === 'string' && part.trim() !== '')
    .join(' — ');
  return `Close the maturity gap${subject ? `: ${subject}` : ': this assessed subject'}`.slice(
    0,
    200,
  );
}

/**
 * A generated task's description RESTATES what the assessment recorded: the numbers a person entered and
 * their own findings text. It says nothing about the law and never claims compliance — the platform does
 * not decide that (skill grc-domain, sections 1 and 8).
 */
function descriptionFor(item: GapItemRecord, assessment: AssessmentRecord): string {
  const lines = [
    `Raised automatically from the gap recorded for this subject in the assessment "${assessment.title}".`,
  ];
  if (item.currentMaturity !== null && item.targetMaturity !== null) {
    lines.push(
      `Recorded maturity ${item.currentMaturity} against a target of ${item.targetMaturity}: a gap of ${item.gap} level(s).`,
    );
  }
  if (item.riskLevel !== null) lines.push(`Risk level of the finding: ${item.riskLevel}.`);
  const findings = item.findings?.trim();
  if (findings) lines.push(`Findings as recorded: ${findings}`);
  lines.push('This task is a piece of work to plan, not a statement that anything is compliant.');
  return lines.join('\n').slice(0, 4000);
}

/** Who is asking, and what their role and assignment allow. */
interface Caller {
  membershipId?: string;
  may: (permission: Permission) => boolean;
}

/**
 * Remediation tasks: the work raised from an assessment's gaps.
 *
 * Rules that live here, and nowhere else:
 * - the status lifecycle is decided ONLY by the domain transition table (`src/domain/remediation/policy.ts`);
 * - who may change what: `governance.edit` covers everything a `by: 'work'` step allows, the assignee and
 *   the task; a STANDARD_USER holds `remediation.updateOwn` and may only comment and move a task assigned
 *   to their OWN membership through a `by: 'work'` step. The decorator on the route can name one permission
 *   at most, so the real check is here.
 * - Generate makes one task per item that HAS a gap, in ONE transaction, and leaves a subject that already
 *   has an active task alone: a re-run neither duplicates nor resurrects archived work.
 * - `due_date` is a DATE, and "overdue" is a calendar-day comparison in the ORGANISATION's time zone,
 *   decided with the injected clock.
 * - Every change appends to the task's own append-only timeline and is audited in the same transaction.
 *
 * Missing data stays missing: no due date, no ratings, no risk level and no assignee are all reported as
 * absent, never as a value or a verdict.
 */
@Injectable()
export class RemediationService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly tasks: RemediationRepository,
    private readonly timeline: RemediationTimelineRepository,
    private readonly scoring: ScoringService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly requestContext: RequestContext,
  ) {}

  async list(query: ListRemediationTasksQueryDto): Promise<RemediationTaskPageDto> {
    const limit = pageSizeOf(query);
    return this.uow.run(async (tx) => {
      const today = await this.today(tx);
      const rows = await this.tasks.list(tx, {
        limit,
        today: utcDay(today),
        ...(query.after ? { after: query.after } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(query.priority ? { priority: query.priority } : {}),
        ...(query.assigneeMembershipId ? { assigneeMembershipId: query.assigneeMembershipId } : {}),
        ...(query.businessUnitId ? { businessUnitId: query.businessUnitId } : {}),
        ...(query.frameworkId ? { frameworkId: query.frameworkId } : {}),
        ...(query.overdue === undefined ? {} : { overdue: query.overdue }),
        ...(query.q ? { q: query.q } : {}),
      });
      const page = toPage(rows, limit);
      return { items: page.items.map((row) => toTaskDto(row, today)), nextCursor: page.nextCursor };
    });
  }

  async get(id: string): Promise<RemediationTaskDetailDto> {
    return this.uow.run(async (tx) => {
      const today = await this.today(tx);
      const task = await this.tasks.findById(tx, id);
      if (!task) throw notFound('Remediation task');
      return this.detailOf(tx, task, today);
    });
  }

  /** The timeline on its own (the detail carries it too; a screen that only lists it needs one call). */
  async events(id: string): Promise<RemediationTaskEventDto[]> {
    return this.uow.run(async (tx) => {
      const task = await this.tasks.findById(tx, id);
      if (!task) throw notFound('Remediation task');
      const events = await this.timeline.listForTask(tx, task.id);
      return events.map(toEventDto);
    });
  }

  async create(dto: CreateRemediationTaskDto): Promise<RemediationTaskDetailDto> {
    return this.uow.run(async (tx) => {
      const today = await this.today(tx);
      if (dto.assigneeMembershipId) await this.activeMember(tx, dto.assigneeMembershipId);
      const item = await this.assertSubjects(tx, dto);
      const created = await this.tasks.create(tx, {
        title: dto.title,
        description: dto.description ?? null,
        priority: dto.priority,
        assigneeMembershipId: dto.assigneeMembershipId ?? null,
        dueDate: dto.dueDate ? utcDay(dto.dueDate) : null,
        assessmentItemId: dto.assessmentItemId ?? null,
        governanceAreaId: dto.governanceAreaId ?? null,
        requirementId: dto.requirementId ?? null,
        businessUnitId: dto.businessUnitId ?? null,
        frameworkId: dto.frameworkId ?? null,
        // the finding's own ratings, frozen: a later re-score does not rewrite what this task was raised for
        ...snapshotOf(item),
        autoGenerated: false,
        createdByUserId: this.actorUserId(),
      });
      await this.audit.record(tx, {
        action: 'remediation_task.created',
        entityType: 'remediation_task',
        entityId: created.id,
        entityLabel: created.title,
        // The shape of the task only: which subject it is about is on the record, who it is assigned to stays out of the audit.
        changes: { priority: created.priority, linkedItem: created.assessmentItemId !== null },
      });
      return this.detailOf(tx, created, today);
    });
  }

  /**
   * One task per item of the assessment that HAS a gap, in ONE transaction. Priority follows the item's
   * risk level; an item with a gap but NO risk level (its ratings are incomplete) is SKIPPED with a
   * reason — this platform invents no priority and no default for missing ratings. A subject that already
   * has a task in an active status is skipped too, so a re-run is safe.
   */
  async generate(dto: GenerateRemediationTasksDto): Promise<GeneratedRemediationTasksDto> {
    return this.uow.run(async (tx) => {
      const assessment = await this.tasks.findAssessment(tx, dto.assessmentId);
      if (!assessment) throw notFound('Assessment');
      const items = await this.tasks.gapItems(tx, assessment.id);
      const today = await this.today(tx);
      const dueDays = await this.dueDaysForPriority(tx);
      const busy = await this.tasks.itemIdsWithActiveTask(
        tx,
        items.map((item) => item.id),
      );
      const createdByUserId = this.actorUserId();

      const rows: TaskCreateData[] = [];
      const skippedItems: GeneratedTaskSkipDto[] = [];
      // in memory only: the reads above are set-based and the insert below is one statement
      for (const item of items) {
        if (busy.has(item.id)) {
          skippedItems.push({
            assessmentItemId: item.id,
            reason: 'ACTIVE_TASK_EXISTS',
            detail:
              'This subject already has a task that is open, in progress, blocked or completed, so no second one was made.',
          });
          continue;
        }
        if (item.riskLevel === null) {
          skippedItems.push({
            assessmentItemId: item.id,
            reason: 'NO_RISK_LEVEL',
            detail:
              'This gap has no risk level, because its sensitivity, severity and likelihood are not all recorded yet, so no priority can be derived. Rate the finding and generate again, or raise the task by hand.',
          });
          continue;
        }
        const priority = priorityForRisk(item.riskLevel);
        rows.push({
          title: titleFor(item),
          description: descriptionFor(item, assessment),
          priority,
          assigneeMembershipId: null,
          dueDate: utcDay(dueDateFor(priority, today, dueDays)),
          assessmentItemId: item.id,
          governanceAreaId: item.governanceAreaId,
          requirementId: item.requirementId,
          businessUnitId: item.businessUnitId,
          frameworkId: item.frameworkId,
          // frozen at the moment the task was raised: the next re-score must not rewrite this task's history
          ...snapshotOf(item),
          autoGenerated: true,
          createdByUserId,
        });
      }

      const ids = await this.tasks.createMany(tx, rows);
      const created = await this.tasks.listByIds(tx, ids);
      const skipped = skippedItems.length;
      await this.audit.record(tx, {
        action: 'remediation_task.generated',
        entityType: 'remediation_task',
        // counts and the assessment id only: never the contents of a record
        changes: { assessmentId: assessment.id, gaps: items.length, created: ids.length, skipped },
      });
      return {
        created: ids.length,
        skipped,
        items: created.map((row) => toTaskDto(row, today)),
        skippedItems,
      };
    });
  }

  /**
   * Edit a task: omit a field to keep it, send `null` or a blank to clear `description`, `dueDate` and
   * `assigneeMembershipId`; `title` and `priority` cannot be cleared. The subject is not editable at all
   * (see `UpdateRemediationTaskDto`), and a task is independent work: it stays editable after its
   * assessment was approved.
   */
  async update(id: string, dto: UpdateRemediationTaskDto): Promise<RemediationTaskDetailDto> {
    return this.uow.run(async (tx) => {
      const today = await this.today(tx);
      const current = await this.mustFind(tx, id);
      const caller = this.caller();
      // editing the task itself is `governance.edit` work; a Standard User's own-task rights are the
      // assignee's comment and `by: 'work'` status steps, nothing else
      if (!caller.may('governance.edit')) throw notAssignee();
      if (current.version !== dto.version) throw versionConflict();
      // Both are NOT NULL columns: a sent `null` is a refusal, never a write of null.
      if (dto.title === null) {
        throw invalid('title', 'isString', 'A title is required: it cannot be cleared.');
      }
      if (dto.priority === null) {
        throw invalid('priority', 'isIn', 'A priority is required: it cannot be cleared.');
      }

      const changes: TaskUpdateData = {};
      const audited: Record<string, unknown> = {};
      if (dto.title !== undefined && dto.title !== current.title) {
        changes.title = dto.title;
        audited.title = 'changed';
      }
      if (dto.priority !== undefined && dto.priority !== current.priority) {
        changes.priority = dto.priority;
        audited.priority = 'changed';
      }
      if (dto.description !== undefined && dto.description !== current.description) {
        changes.description = dto.description;
        audited.description = 'changed';
      }
      if (dto.dueDate !== undefined) {
        const next = dto.dueDate ? utcDay(dto.dueDate) : null;
        if (toDateOnly(next) !== toDateOnly(current.dueDate)) {
          changes.dueDate = next;
          audited.dueDate = 'changed';
        }
      }
      let assigneeName: string | null = null;
      if (
        dto.assigneeMembershipId !== undefined &&
        dto.assigneeMembershipId !== current.assigneeMembershipId
      ) {
        if (dto.assigneeMembershipId === null) {
          changes.assigneeMembershipId = null;
        } else {
          assigneeName = (await this.activeMember(tx, dto.assigneeMembershipId)).fullName;
          changes.assigneeMembershipId = dto.assigneeMembershipId;
        }
        audited.assigneeMembershipId = 'changed';
      }

      if (Object.keys(changes).length === 0) return this.detailOf(tx, current, today);
      if (!(await this.tasks.update(tx, id, current.version, changes))) throw versionConflict();

      if ('assigneeMembershipId' in changes) {
        // one ASSIGNMENT line on the append-only timeline: who took the work over, and when
        await this.timeline.append(tx, id, {
          kind: 'ASSIGNMENT',
          body: assigneeName ? `Assigned to ${assigneeName}` : 'Assignee removed',
          actorUserId: this.actorUserId(),
        });
      }
      await this.audit.record(tx, {
        action: 'remediation_task.updated',
        entityType: 'remediation_task',
        entityId: id,
        entityLabel: changes.title ?? current.title,
        // field names only: a title and a description are a person's words
        changes: audited,
      });
      const fresh = await this.tasks.findById(tx, id);
      return this.detailOf(tx, fresh ?? current, today);
    });
  }

  /**
   * Move a task along its lifecycle. Only the domain transition table decides whether a step exists, and
   * only the caller's role and assignment decide whether THIS caller may take it. A step that exists but
   * is not allowed for the caller is 403, not a hidden 404: the member may see the task.
   */
  async changeStatus(
    id: string,
    dto: ChangeRemediationTaskStatusDto,
  ): Promise<RemediationTaskDetailDto> {
    return this.uow.run(async (tx) => {
      const today = await this.today(tx);
      const current = await this.mustFind(tx, id);
      if (dto.version !== undefined && current.version !== dto.version) throw versionConflict();

      const transition = findTransition(current.status, dto.toStatus);
      if (!transition) {
        throw invalidTransition(
          current.status,
          dto.toStatus,
          nextStatuses(current.status).map((step) => step.to),
        );
      }
      const reason = dto.reason ?? null;
      if (transition.needsReason && reason === null) throw reopenNeedsReason(dto.toStatus);
      this.assertMayTake(current, transition);

      const at = this.clock.now();
      const by = this.actorUserId();
      const changes: TaskUpdateData = { status: dto.toStatus };
      if (dto.toStatus === 'COMPLETED') {
        changes.completedAt = at;
        changes.completedByUserId = by;
      }
      if (dto.toStatus === 'VERIFIED') {
        changes.verifiedAt = at;
        changes.verifiedByUserId = by;
      }
      // Leaving VERIFIED must clear its stamp: `remediation_tasks_check` ties verified_at to the status.
      // Leaving COMPLETED keeps its stamp and that is allowed — the check only demands a completed_at for
      // a task that IS completed or verified, and it is the history of the work.
      if (current.status === 'VERIFIED') {
        changes.verifiedAt = null;
        changes.verifiedByUserId = null;
      }
      if (!(await this.tasks.update(tx, id, current.version, changes))) throw versionConflict();

      // exactly ONE timeline row for the step, in the same transaction
      await this.timeline.append(tx, id, {
        kind: 'STATUS_CHANGE',
        fromStatus: current.status,
        toStatus: dto.toStatus,
        body: reason,
        actorUserId: by,
      });
      await this.audit.record(tx, {
        action: 'remediation_task.status_changed',
        entityType: 'remediation_task',
        entityId: id,
        entityLabel: current.title,
        changes: { status: { from: current.status, to: dto.toStatus } },
      });
      const fresh = await this.tasks.findById(tx, id);
      return this.detailOf(tx, fresh ?? current, today);
    });
  }

  /**
   * Append a comment to the timeline. A person holding `governance.edit` may comment on any task; without
   * it the caller must hold `remediation.updateOwn` AND be the assignee of this task (a READ_ONLY member
   * passes the route's `governance.view` but does neither, so it is refused here).
   * The task row itself does not change, so its `version` does not move.
   */
  async comment(id: string, dto: CommentRemediationTaskDto): Promise<RemediationTaskDetailDto> {
    return this.uow.run(async (tx) => {
      const today = await this.today(tx);
      const current = await this.mustFind(tx, id);
      if (!this.mayWork(current)) throw notAssignee();
      await this.timeline.append(tx, id, {
        kind: 'COMMENT',
        body: dto.body,
        actorUserId: this.actorUserId(),
      });
      await this.audit.record(tx, {
        action: 'remediation_task.commented',
        entityType: 'remediation_task',
        entityId: id,
        entityLabel: current.title,
        changes: { length: dto.body.length },
      });
      const events = await this.timeline.listForTask(tx, id);
      return toDetailDto(
        current,
        today,
        events.map(toEventDto),
        await this.timeline.evidenceIdsForTask(tx, id),
        this.allowedTransitions(current),
      );
    });
  }

  // ---- the checks, all of them here and none of them in the controller

  /** The task, or 404: another tenant's id and an unknown id are the same answer. */
  private async mustFind(tx: Tx, id: string): Promise<TaskRecord> {
    const task = await this.tasks.findById(tx, id);
    if (!task) throw notFound('Remediation task');
    return task;
  }

  /** Today in the organisation's own zone: a due date never means anything in the server's zone. */
  private async today(tx: Tx): Promise<string> {
    return todayIn(await this.tasks.timezone(tx), this.clock.now());
  }

  /** The organisation's due days per priority, read through the scoring service so a deadline set here is
   * the same one `GET …/scoring` shows. */
  private async dueDaysForPriority(tx: Tx): Promise<DueDays> {
    return (await this.scoring.policyInForce(tx)).dueDays;
  }

  private caller(): Caller {
    const { role, membershipId } = this.requestContext.get();
    return {
      ...(membershipId ? { membershipId } : {}),
      may: (permission) => role !== undefined && roleHas(role, permission),
    };
  }

  /**
   * May this caller do the WORK on this task: an editor of remediation work, or the holder of
   * `remediation.updateOwn` on the task that is assigned to their OWN membership. The assignee is read
   * from the row, never from what the client claims.
   */
  private mayWork(task: TaskRecord, caller: Caller = this.caller()): boolean {
    if (caller.may('governance.edit')) return true;
    return (
      caller.may('remediation.updateOwn') &&
      caller.membershipId !== undefined &&
      task.assigneeMembershipId === caller.membershipId
    );
  }

  /** Who may take one step: an approver for `by: 'approve'`, the assignee or an editor for `by: 'work'`. */
  private assertMayTake(task: TaskRecord, transition: Transition): void {
    if (transition.by === 'approve') {
      if (!this.caller().may('governance.approve')) throw notAssignee();
      return;
    }
    if (!this.mayWork(task)) throw notAssignee();
  }

  /** The steps THIS caller can take now, so the UI never offers a forbidden action. */
  private allowedTransitions(task: TaskRecord): TaskTransitionDto[] {
    const caller = this.caller();
    return nextStatuses(task.status)
      .filter((step) =>
        step.by === 'approve' ? caller.may('governance.approve') : this.mayWork(task, caller),
      )
      .map(({ to, by, needsReason }) => ({ toStatus: to, by, needsReason }));
  }

  private detailOf(tx: Tx, task: TaskRecord, today: string): Promise<RemediationTaskDetailDto> {
    return Promise.all([
      this.timeline.listForTask(tx, task.id),
      this.timeline.evidenceIdsForTask(tx, task.id),
    ]).then(([events, evidenceIds]) =>
      toDetailDto(task, today, events.map(toEventDto), evidenceIds, this.allowedTransitions(task)),
    );
  }

  /** The assignee must be an ACTIVE member of this organisation (as a business unit's head must be). */
  private async activeMember(tx: Tx, membershipId: string) {
    const member = await this.tasks.findActiveMember(tx, membershipId);
    if (!member) {
      throw invalid(
        'assigneeMembershipId',
        'notAnActiveMember',
        'The assignee must be an active member of this organisation.',
      );
    }
    return member;
  }

  /**
   * Every subject a task is pointed at must exist in THIS organisation (a foreign id is a field error).
   * The assessment item comes back with its ratings, because the task freezes them as its snapshot; null when
   * the task points at no item.
   */
  private async assertSubjects(
    tx: Tx,
    dto: CreateRemediationTaskDto,
  ): Promise<TaskItemRatings | null> {
    const item = dto.assessmentItemId ? await this.tasks.findItem(tx, dto.assessmentItemId) : null;
    if (dto.assessmentItemId && !item) {
      throw invalid(
        'assessmentItemId',
        'unknownAssessmentItem',
        'The assessment item does not exist in this organisation.',
      );
    }
    if (dto.governanceAreaId && !(await this.tasks.findArea(tx, dto.governanceAreaId))) {
      throw invalid(
        'governanceAreaId',
        'unknownGovernanceArea',
        'The governance area does not exist in this organisation.',
      );
    }
    if (dto.businessUnitId && !(await this.tasks.findBusinessUnit(tx, dto.businessUnitId))) {
      throw invalid(
        'businessUnitId',
        'unknownBusinessUnit',
        'The business unit does not exist in this organisation.',
      );
    }
    if (dto.requirementId && !(await this.tasks.findRequirement(tx, dto.requirementId))) {
      throw invalid('requirementId', 'unknownRequirement', 'The requirement does not exist.');
    }
    if (dto.frameworkId && !(await this.tasks.findFramework(tx, dto.frameworkId))) {
      throw invalid('frameworkId', 'unknownFramework', 'The framework does not exist.');
    }
    return item;
  }

  /** The person the change is attributed to; a task and its timeline are always attributed. */
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
