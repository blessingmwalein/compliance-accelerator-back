import { HttpStatus, Injectable } from '@nestjs/common';
import { AlertsService } from '../alerts/alerts.service.js';
import { AuditService } from '../audit/audit.service.js';
import { Clock } from '../common/clock.js';
import { AppException, ErrorCode } from '../common/errors/app.exception.js';
import { pageSizeOf, toPage } from '../common/pagination.js';
import type { Tx } from '../database/db-client.js';
import { UnitOfWork } from '../database/unit-of-work.js';
import { DeadlinePolicyService } from '../deadline-policy/deadline-policy.service.js';
import { deadlineViewOf, effectiveLeadDays } from '../domain/incidents/deadline.js';
import {
  BREACHED_SLA_BUCKETS,
  dsarClosureBlock,
  findDsarTransition,
  isTerminalDsarStatus,
  nextDsarStatuses,
  slaBucketOf,
  slaPercentage,
  type DsarStatus,
  type DsarTransition,
  type SlaBucket,
} from '../domain/incidents/dsar.js';
import {
  EXTENSION_BLOCK_REASONS,
  dsarScheduleOf,
  extensionDecisionOf,
} from '../domain/incidents/policy.js';
import { addDays, todayIn } from '../domain/remediation/policy.js';
import { dayOf, toDateOnly, utcDay } from '../domain/registers/review.js';
import { roleHas, type Permission } from '../permissions/catalogue.js';
import { RequestContext } from '../tenancy/request-context.js';
import type {
  AddDsarCommunicationDto,
  ChangeDsarStatusDto,
  CreateDsarRequestDto,
  DsarCommunicationDto,
  DsarEvidenceDto,
  DsarRequestDetailDto,
  DsarRequestDto,
  DsarRequestPageDto,
  DsarSlaDto,
  DsarStatusTransitionDto,
  ExtendDsarRequestDto,
  LinkDsarEvidenceDto,
  ListDsarQueryDto,
  UpdateDsarRequestDto,
  VerifyDsarIdentityDto,
} from './dsar.dto.js';
import {
  DsarRepository,
  type DsarChanges,
  type DsarCommunicationRecord,
  type DsarEvidenceRecord,
  type DsarNewRequest,
  type DsarRecord,
  type DsarSlaRow,
} from './dsar.repository.js';

const notFound = (what: string) =>
  new AppException(ErrorCode.NotFound, HttpStatus.NOT_FOUND, `${what} not found.`);
const versionConflict = () =>
  new AppException(
    ErrorCode.VersionConflict,
    HttpStatus.CONFLICT,
    'This request was changed by someone else. Reload and try again.',
  );
/** A closed request is a dated decision: its content is fixed, its chronology stays readable. */
const alreadyClosed = (status: DsarStatus) =>
  new AppException(
    ErrorCode.RecordAlreadyClosed,
    HttpStatus.CONFLICT,
    `This request is ${status}. Its outcome is recorded; change nothing about it.`,
  );
const invalid = (path: string, code: string, message: string) =>
  new AppException(
    ErrorCode.ValidationFailed,
    HttpStatus.BAD_REQUEST,
    'Request validation failed.',
    [{ path, code, message }],
  );
const invalidTransition = (from: DsarStatus, allowed: readonly DsarStatus[]) =>
  new AppException(
    ErrorCode.InvalidTransition,
    HttpStatus.CONFLICT,
    allowed.length === 0
      ? `A request that is ${from} cannot change status.`
      : `A request that is ${from} can only become ${allowed.join(', ')}.`,
    [{ path: 'toStatus', code: 'invalidTransition', message: `Allowed: ${allowed.join(', ')}.` }],
  );
const forbidden = (message: string) =>
  new AppException(ErrorCode.Forbidden, HttpStatus.FORBIDDEN, message);

/** The receiving window `dsar.sla` looks back over: the last twelve months (docs/metrics/README.md). */
const SLA_WINDOW_DAYS = 365;

const EMPTY_SLA = {
  withinSla: 0,
  completedLate: 0,
  openPastDeadline: 0,
  openNotYetDue: 0,
  notMeasured: 0,
} satisfies Record<SlaBucket, number>;

const toCommunicationDto = (record: DsarCommunicationRecord): DsarCommunicationDto => ({
  id: record.id,
  kind: record.kind,
  occurredOn: dayOf(record.occurredOn),
  note: record.note,
  createdByUserId: record.createdByUserId,
  createdAt: record.createdAt.toISOString(),
});

const toEvidenceDto = (record: DsarEvidenceRecord): DsarEvidenceDto => ({
  evidenceId: record.evidenceId,
  title: record.title,
  reviewStatus: record.reviewStatus,
  currentVersion: record.currentVersion,
  linkedByUserId: record.linkedByUserId,
  linkedAt: record.linkedAt.toISOString(),
});

/** What the caller may do to this row: the same table, filtered by the caller's role. */
const transitionDto = (step: DsarTransition): DsarStatusTransitionDto => ({
  toStatus: step.to,
  by: step.by,
  needsNote: step.needsNote,
  needsEvidence: step.needsEvidence,
});

/**
 * The data subject request tracker (AC-DSAR-01, AC-DSAR-02, AC-DSAR-03).
 *
 * Every deadline on a row is a frozen copy of the policy that was in force when the request arrived: no
 * read and no extension recomputes a date from today's policy, so a report shows the window the request was
 * actually worked to. The lifecycle, the extension rule, the deadline states and the SLA buckets all come
 * from `src/domain/incidents`; nothing here restates them.
 *
 * Personal data stays in the row. The audit trail names the decision and its dates, never the subject's
 * name, their request or the text of a note.
 */
@Injectable()
export class DsarService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly dsar: DsarRepository,
    private readonly alerts: AlertsService,
    private readonly policies: DeadlinePolicyService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly requestContext: RequestContext,
  ) {}

  async list(query: ListDsarQueryDto): Promise<DsarRequestPageDto> {
    const limit = pageSizeOf(query);
    return this.uow.run(async (tx) => {
      const rows = await this.dsar.list(tx, {
        limit,
        ...(query.after ? { after: query.after } : {}),
        ...(query.q ? { q: query.q } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(query.requestType ? { requestType: query.requestType } : {}),
        ...(query.identityState ? { identityState: query.identityState } : {}),
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

  detail(id: string): Promise<DsarRequestDetailDto> {
    return this.uow.run(async (tx) =>
      this.detailIn(tx, await this.mustFind(tx, id), await this.today(tx), await this.leadDays(tx)),
    );
  }

  /**
   * `dsar.sla`, counted over the requests received in the last twelve months. A refusal or a withdrawal is
   * `notMeasured`: the definition counts a request as answered when it was completed, and putting a refusal
   * on either side of the fraction would invent a rule the definition does not state.
   */
  async sla(): Promise<DsarSlaDto> {
    return this.uow.run(async (tx) => {
      const [timezone, policy] = await Promise.all([
        this.dsar.timezone(tx),
        this.policies.policyInForce(tx),
      ]);
      const today = todayIn(timezone, this.clock.now());
      const windowDays = policy?.dsarResponseDays ?? null;
      const rows = await this.dsar.slaRows(tx, addDays(today, -SLA_WINDOW_DAYS));
      const records = rows.length;
      if (windowDays === null) {
        // no window in force: there is nothing to measure, so no bucket is counted and no percentage given
        return {
          state: 'not_configured',
          configured: false,
          windowDays: null,
          records,
          withinSla: 0,
          completedLate: 0,
          openPastDeadline: 0,
          openNotYetDue: 0,
          breached: 0,
          percentage: null,
          today,
        };
      }

      const tally = { ...EMPTY_SLA };
      for (const row of rows) tally[bucketOf(row, today)] += 1;
      const breached = BREACHED_SLA_BUCKETS.reduce((sum, bucket) => sum + tally[bucket], 0);
      const percentage = slaPercentage(tally.withinSla, breached);
      return {
        // an empty denominator is the same answer as an empty register: nothing was counted either way
        state: percentage === null ? 'no_records' : 'measured',
        configured: true,
        windowDays,
        records,
        withinSla: tally.withinSla,
        completedLate: tally.completedLate,
        openPastDeadline: tally.openPastDeadline,
        openNotYetDue: tally.openNotYetDue,
        breached,
        percentage,
        today,
      };
    });
  }

  /** The request, the frozen deadline its policy gave it, and the alerts that deadline announced. */
  async create(dto: CreateDsarRequestDto): Promise<DsarRequestDetailDto> {
    return this.uow.run(async (tx) => {
      const timezone = await this.dsar.timezone(tx);
      const today = todayIn(timezone, this.clock.now());
      if (dto.receivedOn > today) {
        throw invalid(
          'receivedOn',
          'inTheFuture',
          `A request cannot be received after today (${today}). Say the day it arrived.`,
        );
      }
      await this.assertSubjects(tx, {
        businessUnitId: dto.businessUnitId ?? null,
        ownerMembershipId: dto.ownerMembershipId ?? null,
      });

      const policy = await this.policies.policyInForce(tx);
      const schedule = dsarScheduleOf(policy, dto.receivedOn, 0);
      const fields: DsarNewRequest = {
        requestType: dto.requestType,
        summary: dto.summary ?? null,
        subjectName: dto.subjectName ?? null,
        subjectEmail: dto.subjectEmail ?? null,
        businessUnitId: dto.businessUnitId ?? null,
        ownerMembershipId: dto.ownerMembershipId ?? null,
        receivedOn: utcDay(dto.receivedOn),
        policyId: schedule.policyId,
        responseDays: schedule.responseDays,
        baseDueOn: schedule.baseDueOn === null ? null : utcDay(schedule.baseDueOn),
        dueOn: schedule.dueOn === null ? null : utcDay(schedule.dueOn),
      };
      const created = await this.dsar.create(tx, fields, this.actorUserId());
      await this.audit.record(tx, {
        action: 'dsar_request.created',
        entityType: 'dsar_request',
        entityId: created.id,
        // the subject's name and their words are never audited: only the window the row was frozen to
        changes: {
          requestType: created.requestType,
          status: created.status,
          responseDays: created.responseDays,
          dueOn: schedule.dueOn,
        },
      });

      if (schedule.dueOn !== null) {
        await this.alerts.queueDeadlines(tx, {
          dueSoon: 'DSAR_DUE_SOON',
          overdue: 'DSAR_OVERDUE',
          source: { dsarRequestId: created.id },
          dueOn: schedule.dueOn,
          leadDays: effectiveLeadDays(null, policy?.alertLeadDays ?? null),
          timezone,
        });
      }
      return this.detailIn(
        tx,
        created,
        today,
        effectiveLeadDays(null, policy?.alertLeadDays ?? null),
      );
    });
  }

  /** The request's own content. The dates, the outcome and the proof have their own endpoints. */
  async update(id: string, dto: UpdateDsarRequestDto): Promise<DsarRequestDto> {
    return this.uow.run(async (tx) => {
      const current = await this.mustFind(tx, id);
      if (current.version !== dto.version) throw versionConflict();
      if (isTerminalDsarStatus(current.status)) throw alreadyClosed(current.status);

      const changes: DsarChanges = {};
      const audited: Record<string, unknown> = {};
      const apply = <K extends keyof DsarChanges>(key: K, next: DsarChanges[K] | undefined) => {
        if (next === undefined || next === current[key]) return;
        changes[key] = next;
        // the subject's name, address and summary are personal data: the trail says the field moved
        audited[key] =
          key === 'summary' || key === 'subjectName' || key === 'subjectEmail'
            ? 'changed'
            : { from: current[key], to: next };
      };

      apply('requestType', dto.requestType);
      apply('summary', dto.summary);
      apply('subjectName', dto.subjectName);
      apply('subjectEmail', dto.subjectEmail);
      apply('businessUnitId', dto.businessUnitId);
      apply('ownerMembershipId', dto.ownerMembershipId);
      if (Object.keys(changes).length === 0) {
        return this.toDto(current, await this.today(tx), await this.leadDays(tx));
      }

      await this.assertSubjects(tx, changes);
      if (!(await this.dsar.update(tx, id, dto.version, changes))) throw versionConflict();
      await this.audit.record(tx, {
        action: 'dsar_request.updated',
        entityType: 'dsar_request',
        entityId: id,
        changes: audited,
      });
      const fresh = await this.dsar.findById(tx, id);
      return this.toDto(fresh ?? current, await this.today(tx), await this.leadDays(tx));
    });
  }

  /**
   * One step along the lifecycle. The closing steps belong to an approver, always carry the outcome in
   * words, and require the proof attached: `COMPLETED` also requires a verified identity, which is a rule
   * about the row rather than about the role.
   */
  async changeStatus(id: string, dto: ChangeDsarStatusDto): Promise<DsarRequestDetailDto> {
    return this.uow.run(async (tx) => {
      const current = await this.mustFind(tx, id);
      if (current.version !== dto.version) throw versionConflict();
      if (dto.toStatus === current.status) {
        throw invalid('toStatus', 'unchanged', `This request is already ${current.status}.`);
      }
      const transition = findDsarTransition(current.status, dto.toStatus);
      if (!transition) {
        throw invalidTransition(
          current.status,
          nextDsarStatuses(current.status).map((step) => step.to),
        );
      }
      this.assertMayTake(transition);
      const note = dto.note?.trim() ?? '';
      if (transition.needsNote && note === '') {
        throw invalid(
          'note',
          'noteRequired',
          `Moving a request from ${transition.from} to ${transition.to} needs the outcome in words: say what was decided.`,
        );
      }
      if (!transition.needsNote && note !== '') {
        throw invalid(
          'note',
          'noteWithoutClosure',
          'A note belongs with the step that ends the request. Record an interim note in the communication log.',
        );
      }

      const block = dsarClosureBlock(transition.to, current.identityState);
      if (block !== null) {
        throw new AppException(
          ErrorCode.IdentityNotVerified,
          HttpStatus.UNPROCESSABLE_ENTITY,
          'The requester’s identity has not been verified, so their data cannot be handed over.',
          [{ path: 'identityState', code: block, message: 'Verify the identity first.' }],
        );
      }
      if (transition.needsEvidence && (await this.dsar.evidenceCount(tx, current.id)) === 0) {
        throw invalid(
          'evidence',
          'evidenceRequired',
          `Attach the proof first: a request cannot become ${transition.to} with no evidence file linked to it.`,
        );
      }

      const today = await this.today(tx);
      const closing = isTerminalDsarStatus(transition.to);
      if (
        !(await this.dsar.update(tx, id, dto.version, {
          status: transition.to,
          ...(closing
            ? {
                closureNote: note,
                completedOn: utcDay(today),
                completedByUserId: this.actorUserId(),
              }
            : {}),
        }))
      ) {
        throw versionConflict();
      }
      await this.audit.record(tx, {
        action: 'dsar_request.status_changed',
        entityType: 'dsar_request',
        entityId: id,
        // the outcome's words live in the row; the trail records that they were written and by whom
        changes: {
          status: { from: transition.from, to: transition.to },
          ...(closing ? { completedOn: today, note: 'recorded' } : {}),
        },
      });
      const fresh = await this.mustFind(tx, id);
      return this.detailIn(tx, fresh, today, await this.leadDays(tx));
    });
  }

  /**
   * Prove the requester is who they say they are. A verification is a named person's dated decision, and
   * the row keeps both: the state cannot be VERIFIED without them.
   */
  async verifyIdentity(id: string, dto: VerifyDsarIdentityDto): Promise<DsarRequestDto> {
    return this.uow.run(async (tx) => {
      const current = await this.mustFind(tx, id);
      if (current.version !== dto.version) throw versionConflict();
      if (current.identityState === 'VERIFIED') {
        throw invalid(
          'identityState',
          'alreadyVerified',
          'This requester’s identity is already verified.',
        );
      }
      const receivedOn = toDateOnly(current.receivedOn) ?? '';
      const verifiedOn = dto.verifiedOn ?? (await this.today(tx));
      if (verifiedOn < receivedOn) {
        throw invalid(
          'verifiedOn',
          'beforeReceived',
          `Identity cannot have been checked before the request arrived (${receivedOn}).`,
        );
      }
      const changes: DsarChanges = {
        identityState: 'VERIFIED',
        identityVerifiedOn: utcDay(verifiedOn),
        identityVerifiedByUserId: this.actorUserId(),
      };
      if (dto.note !== undefined) changes.identityNote = dto.note;

      if (!(await this.dsar.update(tx, id, dto.version, changes))) throw versionConflict();
      await this.audit.record(tx, {
        action: 'dsar_request.identity_verified',
        entityType: 'dsar_request',
        entityId: id,
        changes: {
          identityState: { from: current.identityState, to: 'VERIFIED' },
          verifiedOn,
          ...(dto.note === undefined || dto.note === null ? {} : { note: 'recorded' }),
        },
      });
      const fresh = await this.dsar.findById(tx, id);
      return this.toDto(fresh ?? current, await this.today(tx), await this.leadDays(tx));
    });
  }

  /**
   * Grant one more extension. The days come from the policy in force, the new date from the date the
   * request actually carries — frozen arithmetic, never a recomputed window. The ledger row is written
   * before the request moves, because the database checks the two totals against that ledger.
   */
  async extend(id: string, dto: ExtendDsarRequestDto): Promise<DsarRequestDto> {
    return this.uow.run(async (tx) => {
      const current = await this.mustFind(tx, id);
      if (current.version !== dto.version) throw versionConflict();
      const timezone = await this.dsar.timezone(tx);
      const today = todayIn(timezone, this.clock.now());
      const policy = await this.policies.policyInForce(tx);
      // the request's own frozen date, never a window recomputed from the policy in force today
      const previousDueOn = toDateOnly(current.dueOn);
      const decision = extensionDecisionOf(
        { status: current.status, dueOn: previousDueOn, extensionCount: current.extensionCount },
        policy,
      );
      if (!decision.allowed) {
        throw new AppException(
          ErrorCode.ExtensionNotAllowed,
          HttpStatus.UNPROCESSABLE_ENTITY,
          EXTENSION_BLOCK_REASONS[decision.block],
          [
            {
              path: 'extension',
              code: decision.block,
              message: EXTENSION_BLOCK_REASONS[decision.block],
            },
          ],
        );
      }

      const extensionDays = current.extensionDays + decision.days;
      const extensionCount = current.extensionCount + 1;
      await this.dsar.createExtension(tx, {
        dsarRequestId: current.id,
        days: decision.days,
        reason: dto.reason,
        previousDueOn: utcDay(decision.previousDueOn),
        newDueOn: utcDay(decision.newDueOn),
        decidedByUserId: this.actorUserId(),
      });
      if (
        !(await this.dsar.update(tx, id, dto.version, {
          dueOn: utcDay(decision.newDueOn),
          extensionDays,
          extensionCount,
        }))
      ) {
        throw versionConflict();
      }
      await this.audit.record(tx, {
        action: 'dsar_request.extended',
        entityType: 'dsar_request',
        entityId: id,
        // the reason is the case worker's own words and lives in the ledger row, not in the trail
        changes: {
          days: decision.days,
          previousDueOn: decision.previousDueOn,
          newDueOn: decision.newDueOn,
          extensionCount,
        },
      });

      // the old queued rows are left exactly as they are: they now record STALE_DEADLINE when they run
      await this.alerts.queueDeadlines(tx, {
        dueSoon: 'DSAR_DUE_SOON',
        overdue: 'DSAR_OVERDUE',
        source: { dsarRequestId: current.id },
        dueOn: decision.newDueOn,
        leadDays: effectiveLeadDays(null, policy?.alertLeadDays ?? null),
        timezone,
      });
      const fresh = await this.dsar.findById(tx, id);
      return this.toDto(
        fresh ?? current,
        today,
        effectiveLeadDays(null, policy?.alertLeadDays ?? null),
      );
    });
  }

  /** One line of the communication log: what was asked, what came back, what was noted. Append-only. */
  async addCommunication(id: string, dto: AddDsarCommunicationDto): Promise<DsarRequestDetailDto> {
    return this.uow.run(async (tx) => {
      const current = await this.mustFind(tx, id);
      const created = await this.dsar.createCommunication(tx, {
        dsarRequestId: current.id,
        kind: dto.kind,
        occurredOn: utcDay(dto.occurredOn),
        note: dto.note,
        createdByUserId: this.actorUserId(),
      });
      await this.audit.record(tx, {
        action: 'dsar_request.communication_added',
        entityType: 'dsar_request',
        entityId: id,
        // the note stays in the log row: correspondence is never copied into the trail
        changes: { kind: created.kind, occurredOn: dto.occurredOn },
      });
      return this.detailIn(tx, current, await this.today(tx), await this.leadDays(tx));
    });
  }

  async linkEvidence(id: string, dto: LinkDsarEvidenceDto): Promise<DsarRequestDetailDto> {
    return this.uow.run(async (tx) => {
      const current = await this.mustFind(tx, id);
      const [evidenceId] = await this.dsar.findEvidence(tx, [dto.evidenceId]);
      if (evidenceId === undefined) throw notFound('Evidence');
      if (!(await this.dsar.linkEvidence(tx, current.id, evidenceId, this.actorUserId()))) {
        throw new AppException(
          ErrorCode.Conflict,
          HttpStatus.CONFLICT,
          'This evidence file is already attached to the request.',
        );
      }
      await this.audit.record(tx, {
        action: 'dsar_request.evidence_linked',
        entityType: 'dsar_request',
        entityId: id,
        changes: { evidenceId },
      });
      return this.detailIn(tx, current, await this.today(tx), await this.leadDays(tx));
    });
  }

  /** Detach a file from the request. The file itself stays in the repository. */
  async unlinkEvidence(id: string, evidenceId: string): Promise<void> {
    return this.uow.run(async (tx) => {
      const current = await this.mustFind(tx, id);
      if (!(await this.dsar.unlinkEvidence(tx, current.id, evidenceId))) {
        throw notFound('Evidence link');
      }
      await this.audit.record(tx, {
        action: 'dsar_request.evidence_unlinked',
        entityType: 'dsar_request',
        entityId: id,
        changes: { evidenceId },
      });
    });
  }

  // ---- the checks, all of them here and none of them in the controller

  private caller(): { may: (permission: Permission) => boolean } {
    const { role } = this.requestContext.get();
    return { may: (permission) => role !== undefined && roleHas(role, permission) };
  }

  private assertMayTake(transition: DsarTransition): void {
    if (transition.by === 'approve') {
      if (!this.caller().may('governance.approve')) {
        throw forbidden(
          `Only an approver can move a request from ${transition.from} to ${transition.to}.`,
        );
      }
      return;
    }
    if (!this.caller().may('data.edit')) {
      throw forbidden('Only someone who may edit this organisation’s data can take this step.');
    }
  }

  private allowedTransitions(status: DsarStatus): DsarStatusTransitionDto[] {
    const caller = this.caller();
    return nextDsarStatuses(status)
      .filter((step) =>
        step.by === 'approve' ? caller.may('governance.approve') : caller.may('data.edit'),
      )
      .map(transitionDto);
  }

  private toDto(record: DsarRecord, today: string, leadDays: number | null) {
    const deadline = deadlineViewOf(toDateOnly(record.dueOn), today, leadDays);
    return {
      id: record.id,
      requestType: record.requestType,
      summary: record.summary,
      subjectName: record.subjectName,
      subjectEmail: record.subjectEmail,
      status: record.status,
      identityState: record.identityState,
      receivedOn: dayOf(record.receivedOn),
      businessUnitId: record.businessUnitId,
      businessUnitName: record.businessUnitName,
      ownerMembershipId: record.ownerMembershipId,
      ownerName: record.ownerName,
      policyId: record.policyId,
      responseDays: record.responseDays,
      baseDueOn: toDateOnly(record.baseDueOn),
      dueOn: toDateOnly(record.dueOn),
      extensionDays: record.extensionDays,
      extensionCount: record.extensionCount,
      identityVerifiedOn: toDateOnly(record.identityVerifiedOn),
      identityVerifiedByUserId: record.identityVerifiedByUserId,
      identityNote: record.identityNote,
      closureNote: record.closureNote,
      completedOn: toDateOnly(record.completedOn),
      completedByUserId: record.completedByUserId,
      createdByUserId: record.createdByUserId,
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
      version: record.version,
      deadline,
      allowedTransitions: this.allowedTransitions(record.status),
    };
  }

  private async detailIn(
    tx: Tx,
    record: DsarRecord,
    today: string,
    leadDays: number | null,
  ): Promise<DsarRequestDetailDto> {
    const [communications, evidence] = await Promise.all([
      this.dsar.listCommunications(tx, record.id),
      this.dsar.listEvidence(tx, record.id),
    ]);
    return {
      ...this.toDto(record, today, leadDays),
      communications: communications.map(toCommunicationDto),
      evidence: evidence.map(toEvidenceDto),
    };
  }

  private async mustFind(tx: Tx, id: string): Promise<DsarRecord> {
    const record = await this.dsar.findById(tx, id);
    if (!record) throw notFound('Data subject request');
    return record;
  }

  /** Today in the organisation's own zone: a deadline means nothing in the server's zone. */
  private async today(tx: Tx): Promise<string> {
    return todayIn(await this.dsar.timezone(tx), this.clock.now());
  }

  /**
   * The early-warning window the list rows are judged by. It is not frozen on a request the way its
   * deadline is, so the policy in force is the only answer the API can honestly give.
   */
  private async leadDays(tx: Tx): Promise<number | null> {
    const policy = await this.policies.policyInForce(tx);
    return effectiveLeadDays(null, policy?.alertLeadDays ?? null);
  }

  private async assertSubjects(
    tx: Tx,
    fields: { businessUnitId?: string | null; ownerMembershipId?: string | null },
  ): Promise<void> {
    if (fields.businessUnitId && !(await this.dsar.findBusinessUnit(tx, fields.businessUnitId))) {
      throw invalid(
        'businessUnitId',
        'unknownBusinessUnit',
        'The business unit does not exist in this organisation.',
      );
    }
    if (
      fields.ownerMembershipId &&
      !(await this.dsar.findActiveMember(tx, fields.ownerMembershipId))
    ) {
      throw invalid(
        'ownerMembershipId',
        'notAnActiveMember',
        'The owner must be an active member of this organisation.',
      );
    }
  }

  /** The person the decision is attributed to; a request and every step on it are always attributed. */
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

/** The bucket one row falls in, with its DATE columns read as the organisation's calendar days. */
const bucketOf = (row: DsarSlaRow, today: string): SlaBucket =>
  slaBucketOf(
    { status: row.status, dueOn: toDateOnly(row.dueOn), completedOn: toDateOnly(row.completedOn) },
    today,
  );
