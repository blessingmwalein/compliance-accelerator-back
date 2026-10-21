import { HttpStatus, Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { Clock } from '../common/clock.js';
import { AppException, ErrorCode, type FieldError } from '../common/errors/app.exception.js';
import { isUniqueViolation } from '../common/errors/unique-violation.js';
import { pageSizeOf } from '../common/pagination.js';
import type { Tx } from '../database/db-client.js';
import { UnitOfWork } from '../database/unit-of-work.js';
import {
  EXPOSURE_V1,
  LIKELIHOOD_LABELS,
  MATURITY_LABELS,
  RISK_LEVELS,
  SENSITIVITY_LABELS,
  SEVERITY_LABELS,
} from '../domain/scoring/methodologies.js';
import {
  IMPORTANCE_QUESTIONS,
  QUADRANT_INFO,
  QUADRANTS,
  QUESTION_KEYS,
  RULESET_VERSION,
  URGENCY_QUESTIONS,
  classify,
  cleanAnswers,
  type Answers,
  type Effective,
  type QuestionKey,
  type Quadrant,
} from '../domain/prioritisation/eisenhower.js';
import { RequestContext } from '../tenancy/request-context.js';
import type { EffectivePolicy } from '../scoring/scoring.service.js';
import { ScoringService } from '../scoring/scoring.service.js';
import type {
  AdjustItemPriorityDto,
  ClearItemPriorityAdjustmentDto,
  ItemPriorityDetailDto,
  PriorityAnswerDto,
  PriorityItemDto,
  PriorityItemPageDto,
  PriorityListQueryDto,
  PriorityMatrixDto,
  PriorityPlanWindowDto,
  PriorityQuestionDto,
  PriorityGroupValue,
  PriorityScalesDto,
  QuadrantFilterValue,
  SaveItemPriorityDto,
} from './priorities.dto.js';
import { QUADRANT_SAMPLE_ITEMS_MAX } from './priorities.dto.js';
import {
  PrioritiesRepository,
  type PriorityCandidate,
  type PriorityFilters,
  type PriorityItemRecord,
  type PriorityState,
} from './priorities.repository.js';

/** Items read per round trip while scanning: a distant region pays one round trip per page. */
const SCAN_PAGE = 500;
/** Ceiling on the count scan, so an enormous tenant cannot make the matrix read forever. */
const MAX_MATRIX_SCAN = 25000;
/** Ceiling on the rows scanned to fill one page of the filtered list. */
const MAX_LIST_SCAN = 5000;

/** Assessments, scores and quadrants are informative aids (skill grc-domain section 8). */
const PRIORITY_DISCLAIMER =
  'Priority quadrants are derived from the answers people give about an item. They are an informative ' +
  'triage aid for planning work, not a statement of legal risk: this platform does not provide legal ' +
  'advice and does not guarantee compliance with any law.';

/** One scanned item after the rule has been applied to it. */
interface Resolved {
  itemId: string;
  effective: Effective;
  /** True when the item has no priority row at all, so nobody has opened the questionnaire. */
  unanswered: boolean;
}

/** The Plan window with its provenance. */
type PlanWindow = PriorityPlanWindowDto;

/** The list-row fields as a plain object type, so the detail can add to them without spreading an instance. */
type ItemFields = Pick<PriorityItemDto, keyof PriorityItemDto>;

const notFound = () =>
  new AppException(
    ErrorCode.NotFound,
    HttpStatus.NOT_FOUND,
    'No assessment item with this identifier exists in this organisation.',
  );

const versionConflict = () =>
  new AppException(
    ErrorCode.VersionConflict,
    HttpStatus.CONFLICT,
    'This priority was changed by someone else. Reload and try again.',
  );

const validationFailed = (errors: FieldError[], detail = 'Request validation failed.') =>
  new AppException(ErrorCode.ValidationFailed, HttpStatus.BAD_REQUEST, detail, errors);

const ANSWER_OPTIONS: { value: boolean | null; label: string }[] = [
  { value: true, label: 'Yes' },
  { value: false, label: 'No' },
  { value: null, label: 'Not answered' },
];

/** The questions come from the ruleset; a client never receives a re-worded or invented question. */
const questionsOf = (
  questions: readonly { key: QuestionKey; text: string }[],
  group: PriorityGroupValue,
): PriorityQuestionDto[] => questions.map((question) => ({ ...question, group }));

const answersOf = (state: PriorityState | null): Answers =>
  state ? cleanAnswers(state.answers) : {};

/** The effective flags of a stored row: the answers, with an override taking precedence. */
const effectiveOf = (state: PriorityState | null): Effective =>
  classify(
    answersOf(state),
    state ? { urgent: state.urgentOverride, important: state.importantOverride } : null,
  );

/** Both flags known means every question of both groups carries an explicit Yes or No. */
const isComplete = (answers: Answers): boolean =>
  QUESTION_KEYS.every((key) => answers[key] !== undefined);

const toRecord = (answers: Answers): Record<string, boolean> =>
  Object.fromEntries(
    Object.entries(answers).filter(
      (entry): entry is [string, boolean] => typeof entry[1] === 'boolean',
    ),
  );

const toResolved = (candidate: PriorityCandidate): Resolved => ({
  itemId: candidate.itemId,
  unanswered: candidate.unanswered,
  effective: classify(candidate.answers === null ? {} : cleanAnswers(candidate.answers), {
    urgent: candidate.urgentOverride,
    important: candidate.importantOverride,
  }),
});

const toLabels = (labels: Readonly<Record<number, string>>): { value: number; label: string }[] =>
  Object.entries(labels).map(([value, label]) => ({ value: Number(value), label }));

const scalesOf = (): PriorityScalesDto => ({
  answers: ANSWER_OPTIONS.map((option) => ({ ...option })),
  maturity: toLabels(MATURITY_LABELS),
  sensitivity: toLabels(SENSITIVITY_LABELS),
  severity: toLabels(SEVERITY_LABELS),
  likelihood: toLabels(LIKELIHOOD_LABELS),
  riskLevels: RISK_LEVELS.map((key) => ({
    key,
    label: EXPOSURE_V1.defaultBands.find((band) => band.key === key)?.label ?? key,
  })),
});

/** What the item is about, as one line: only the names the organisation chose, never a legal claim. */
const subjectOf = (item: PriorityItemRecord): string => {
  const parts = [item.governanceAreaName, item.requirementRef ?? item.requirementTitle].filter(
    (part): part is string => Boolean(part),
  );
  return parts.length > 0 ? parts.join(' · ') : 'Assessment item';
};

/**
 * The Plan window as the scoring service reports it. Reading it here rather than parsing the policy row
 * again is what keeps the matrix and `GET …/scoring` in agreement, including the reference default the
 * policy falls back to when the stored JSON is unusable.
 */
const windowOf = (policy: EffectivePolicy): PlanWindow => ({
  minDays: policy.planWindow.minDays,
  maxDays: policy.planWindow.maxDays,
  source: policy.customisedPlanWindow ? 'ORGANISATION_POLICY' : 'REFERENCE_DEFAULT',
});

/** The quadrant's own suggestion; the Plan quadrant names the window that is actually in force. */
const schedulingOf = (quadrant: Quadrant | null, window: PlanWindow): string | null => {
  if (!quadrant) return null;
  if (quadrant !== 'PLAN') return QUADRANT_INFO[quadrant].defaultScheduling;
  return `${QUADRANT_INFO.PLAN.defaultScheduling} (${window.minDays} to ${window.maxDays} days)`;
};

/** `UNCLASSIFIED` is the filter for the items the rule cannot place yet. */
const quadrantMatches = (quadrant: Quadrant | null, filter?: QuadrantFilterValue): boolean => {
  if (!filter) return true;
  return filter === 'UNCLASSIFIED' ? quadrant === null : quadrant === filter;
};

/**
 * The Eisenhower priority matrix (Phase 5). Only the ANSWERS, the ruleset version and an authorised person's
 * override are stored: `urgent`, `important` and the quadrant are derived on every read by the pure domain
 * rule, so a quadrant is never shown without the criteria that produced it (AC-EIS-01).
 *
 * An unanswered question is never a No, so an incomplete questionnaire yields NO quadrant: such items are
 * reported as `unclassified` instead of falling out of the counts. A priority stays editable while the
 * assessment is APPROVED, because triage is not scoring; the item itself is read-only here, since assessment
 * content freezes once its assessment leaves DRAFT.
 */
@Injectable()
export class PrioritiesService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly priorities: PrioritiesRepository,
    private readonly scoring: ScoringService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly requestContext: RequestContext,
  ) {}

  /** The four quadrant counts, the items the rule cannot place, and all wording and scales the UI needs. */
  async matrix(): Promise<PriorityMatrixDto> {
    const scan = await this.uow.run(async (tx) => {
      const rows = await this.resolve(tx, {}, () => true, null);
      const counts = new Map<Quadrant, number>(QUADRANTS.map((quadrant) => [quadrant, 0]));
      // the first items the scan reaches in each quadrant, oldest first — the names a card can show
      const named = new Map<Quadrant, string[]>(QUADRANTS.map((quadrant) => [quadrant, []]));
      let unclassified = 0;
      let withoutQuestionnaire = 0;
      for (const row of rows.items) {
        const quadrant = row.effective.quadrant;
        if (quadrant) {
          counts.set(quadrant, (counts.get(quadrant) ?? 0) + 1);
          const ids = named.get(quadrant);
          if (ids && ids.length < QUADRANT_SAMPLE_ITEMS_MAX) ids.push(row.itemId);
        } else unclassified += 1;
        if (row.unanswered) withoutQuestionnaire += 1;
      }
      const window = windowOf(await this.scoring.policyInForce(tx));
      const items = await this.priorities.findItems(tx, [...named.values()].flat());
      const subjectById = new Map(items.map((item) => [item.id, subjectOf(item)]));
      return {
        counts,
        named,
        subjectById,
        unclassified,
        withoutQuestionnaire,
        totalItems: rows.items.length,
        exhausted: rows.exhausted,
        window,
      };
    });

    return {
      quadrants: QUADRANTS.map((quadrant) => ({
        quadrant,
        label: QUADRANT_INFO[quadrant].label,
        purpose: QUADRANT_INFO[quadrant].purpose,
        defaultScheduling: QUADRANT_INFO[quadrant].defaultScheduling,
        count: scan.counts.get(quadrant) ?? 0,
        // an id the item scan offered but the item read did not return is gone, so it is not named
        sampleItems: (scan.named.get(quadrant) ?? []).flatMap((id) => {
          const subject = scan.subjectById.get(id);
          return subject === undefined ? [] : [{ assessmentItemId: id, subject }];
        }),
        sampleItemsLimit: QUADRANT_SAMPLE_ITEMS_MAX,
      })),
      unclassified: scan.unclassified,
      withoutQuestionnaire: scan.withoutQuestionnaire,
      totalItems: scan.totalItems,
      partial: !scan.exhausted,
      rulesetVersion: RULESET_VERSION,
      urgencyQuestions: questionsOf(URGENCY_QUESTIONS, 'URGENCY'),
      importanceQuestions: questionsOf(IMPORTANCE_QUESTIONS, 'IMPORTANCE'),
      scales: scalesOf(),
      planWindow: scan.window,
      disclaimer: PRIORITY_DISCLAIMER,
    };
  }

  /** A cursor page of items with their derived flags. The quadrant is derived, so it filters after it. */
  async list(query: PriorityListQueryDto): Promise<PriorityItemPageDto> {
    const limit = pageSizeOf(query);
    const filters = filtersOf(query);
    return this.uow.run(async (tx) => {
      const scan = await this.resolve(
        tx,
        filters,
        (row) => quadrantMatches(row.effective.quadrant, query.quadrant),
        limit + 1,
      );
      const hasMore = scan.items.length > limit;
      const page = hasMore ? scan.items.slice(0, limit) : scan.items;
      const records = await this.priorities.findItems(
        tx,
        page.map((row) => row.itemId),
      );
      const byId = new Map(records.map((record) => [record.id, record]));
      // a stopped-but-not-exhausted scan still has rows to come: the cursor is the last id it looked at
      const nextCursor = hasMore
        ? (page.at(-1)?.itemId ?? null)
        : scan.exhausted
          ? null
          : scan.lastScannedId;
      return {
        items: page.flatMap((row) => {
          const record = byId.get(row.itemId);
          return record ? [this.toListItem(record)] : [];
        }),
        nextCursor,
      };
    });
  }

  /** One item: the answers behind the quadrant, the adjustment with its reason, and the related tasks. */
  get(itemId: string): Promise<ItemPriorityDetailDto> {
    return this.uow.run((tx) => this.detail(tx, itemId));
  }

  /**
   * Upsert of the item's single priority row: the client sends the FULL answer set, keys it omits become
   * unanswered, and `version` guards against losing a concurrent edit. An existing override is left alone:
   * saving answers changes the criteria, not the authorised decision.
   */
  save(itemId: string, dto: SaveItemPriorityDto): Promise<ItemPriorityDetailDto> {
    const answers = this.checkAnswers(dto.answers);
    return this.uow.run(async (tx) => {
      const item = await this.priorities.findItem(tx, itemId);
      if (!item) throw notFound();
      const state = item.priority;
      const changes = { answers: 'changed', rulesetVersion: 'changed' };

      if (!state) {
        // the row defaults to version 1, so a client that believes it exists already is out of date
        if (dto.version !== 1) throw versionConflict();
        let created: PriorityState;
        try {
          created = await this.priorities.createPriority(tx, itemId, {
            answers: toRecord(answers),
            rulesetVersion: RULESET_VERSION,
          });
        } catch (error) {
          // two people opened the same unanswered questionnaire: the unique index lets one through, and the
          // other is told their version is stale rather than shown a database error
          if (!isUniqueViolation(error)) throw error;
          throw versionConflict();
        }
        await this.audit.record(tx, {
          action: 'priority.answered',
          entityType: 'item_priority',
          entityId: created.id,
          entityLabel: subjectOf(item),
          changes,
        });
        return this.detail(tx, itemId);
      }

      if (state.version !== dto.version) throw versionConflict();
      const saved = await this.priorities.updatePriority(tx, state.id, dto.version, {
        answers: toRecord(answers),
        rulesetVersion: RULESET_VERSION,
      });
      if (!saved) throw versionConflict();
      await this.audit.record(tx, {
        action: 'priority.answered',
        entityType: 'item_priority',
        entityId: state.id,
        entityLabel: subjectOf(item),
        changes,
      });
      return this.detail(tx, itemId);
    });
  }

  /**
   * An authorised override of a derived flag: `true | false` decides it, `null` stops overriding it and sends
   * it back to the answers. Who, when and why are written together with the override — the database CHECK
   * rejects the row without them.
   */
  adjust(itemId: string, dto: AdjustItemPriorityDto): Promise<ItemPriorityDetailDto> {
    if (dto.urgent === undefined && dto.important === undefined) {
      throw validationFailed(
        [
          {
            path: 'urgent',
            code: 'isPresent',
            message: 'Send urgent, important, or both.',
          },
        ],
        'Send at least one flag to adjust.',
      );
    }
    return this.applyAdjustment(itemId, dto.urgent, dto.important, dto.reason, dto.version);
  }

  /** Withdraws both overrides; the answers stay and the flags follow them again. The reason is still required. */
  clearAdjustment(
    itemId: string,
    dto: ClearItemPriorityAdjustmentDto,
  ): Promise<ItemPriorityDetailDto> {
    return this.applyAdjustment(itemId, null, null, dto.reason, dto.version);
  }

  private async applyAdjustment(
    itemId: string,
    urgent: boolean | null | undefined,
    important: boolean | null | undefined,
    reason: string,
    version: number,
  ): Promise<ItemPriorityDetailDto> {
    const actorUserId = this.requestContext.actorUserId;
    if (!actorUserId) {
      // the access guard has already put an actor in scope, so this is a server fault, not a client's problem
      throw new AppException(
        ErrorCode.InternalError,
        HttpStatus.INTERNAL_SERVER_ERROR,
        'No signed-in user for this request.',
      );
    }
    return this.uow.run(async (tx) => {
      const item = await this.priorities.findItem(tx, itemId);
      if (!item) throw notFound();
      const state = item.priority;
      if (!state) {
        throw new AppException(
          ErrorCode.Conflict,
          HttpStatus.CONFLICT,
          'This item has no priority answers yet, so there is nothing to adjust. Save the questionnaire first.',
        );
      }
      if (state.version !== version) throw versionConflict();

      const data = {
        urgentOverride: urgent === undefined ? state.urgentOverride : urgent,
        importantOverride: important === undefined ? state.importantOverride : important,
        // the reason, the actor and the moment always travel with the decision, and a withdrawal records
        // them too: with no override left the row stays legal and the trail keeps who withdrew it and why
        overrideReason: reason,
        adjustedByUserId: actorUserId,
        adjustedAt: this.clock.now(),
      };
      if (!(await this.priorities.updatePriority(tx, state.id, version, data)))
        throw versionConflict();

      const decided = (value: boolean | null | undefined): string =>
        value === undefined ? 'unchanged' : value === null ? 'withdrawn' : 'overridden';
      await this.audit.record(tx, {
        action: 'priority.adjusted',
        entityType: 'item_priority',
        entityId: state.id,
        entityLabel: subjectOf(item),
        changes: {
          urgentOverride: decided(urgent),
          importantOverride: decided(important),
          overrideReason: 'changed',
          adjustedByUserId: 'changed',
          adjustedAt: 'changed',
        },
      });
      return this.detail(tx, itemId);
    });
  }

  /** A detail read inside the caller's transaction, so a write can return the row as it now stands. */
  private async detail(tx: Tx, itemId: string): Promise<ItemPriorityDetailDto> {
    const item = await this.priorities.findItem(tx, itemId);
    if (!item) throw notFound();
    const window = windowOf(await this.scoring.policyInForce(tx));
    const state = item.priority;
    const answers = answersOf(state);
    const effective = effectiveOf(state);
    const answerOf = (
      questions: readonly { key: QuestionKey; text: string }[],
      group: PriorityGroupValue,
    ) =>
      questions.map((question): PriorityAnswerDto => ({
        ...question,
        group,
        value: answers[question.key] ?? null,
      }));
    const overridden = Boolean(state?.urgentOverride) || Boolean(state?.importantOverride);
    return {
      ...this.toListItem(item),
      rationale: item.rationale,
      findings: item.findings,
      currentMaturity: item.currentMaturity,
      targetMaturity: item.targetMaturity,
      answers: [
        ...answerOf(URGENCY_QUESTIONS, 'URGENCY'),
        ...answerOf(IMPORTANCE_QUESTIONS, 'IMPORTANCE'),
      ],
      adjustment:
        state && overridden
          ? {
              urgent: state.urgentOverride,
              important: state.importantOverride,
              reason: state.overrideReason ?? '',
              adjustedByUserId: state.adjustedByUserId,
              adjustedByName: state.adjustedByName,
              adjustedAt: state.adjustedAt?.toISOString() ?? null,
            }
          : null,
      adjustedByUserId: state?.adjustedByUserId ?? null,
      adjustedByName: state?.adjustedByName ?? null,
      adjustedAt: state?.adjustedAt?.toISOString() ?? null,
      lastAdjustmentReason: state?.overrideReason ?? null,
      taskIds: item.taskIds,
      planWindow: window,
      schedulingSuggestion: schedulingOf(effective.quadrant, window),
      createdAt: state?.createdAt.toISOString() ?? null,
      updatedAt: state?.updatedAt.toISOString() ?? null,
      disclaimer: PRIORITY_DISCLAIMER,
    };
  }

  private toListItem(item: PriorityItemRecord): ItemFields {
    const state = item.priority;
    const effective = effectiveOf(state);
    const quadrant = effective.quadrant;
    return {
      assessmentItemId: item.id,
      assessmentId: item.assessmentId,
      assessmentTitle: item.assessmentTitle,
      assessmentStatus: item.assessmentStatus,
      subject: subjectOf(item),
      governanceAreaId: item.governanceAreaId,
      governanceAreaName: item.governanceAreaName,
      governanceAreaArchived: item.governanceAreaArchived,
      requirementId: item.requirementId,
      requirementRef: item.requirementRef,
      requirementTitle: item.requirementTitle,
      businessUnitId: item.businessUnitId,
      businessUnitName: item.businessUnitName,
      frameworkId: item.frameworkId,
      frameworkCode: item.frameworkCode,
      ownerMembershipId: item.ownerMembershipId,
      ownerName: item.ownerName,
      gap: item.gap,
      exposure: item.exposure,
      riskLevel: item.riskLevel,
      taskCount: item.taskIds.length,
      hasQuestionnaire: state !== null,
      answersComplete: isComplete(answersOf(state)),
      rulesetVersion: state?.rulesetVersion ?? null,
      urgent: effective.urgent,
      important: effective.important,
      quadrant,
      quadrantLabel: quadrant ? QUADRANT_INFO[quadrant].label : null,
      adjusted: effective.adjusted,
      // the version to send back: 1 when the row does not exist yet, because it is created with version 1
      version: state?.version ?? 1,
    };
  }

  /**
   * Reads the items the scalar filters keep and applies the rule to each, one page at a time, until
   * `stopAfter` rows match or the items run out. The quadrant cannot be filtered in SQL: it is derived, and
   * repeating the question keys in a query is how a domain rule drifts.
   */
  private async resolve(
    tx: Tx,
    filters: PriorityFilters,
    matches: (row: Resolved) => boolean,
    stopAfter: number | null,
  ): Promise<{ items: Resolved[]; exhausted: boolean; lastScannedId: string | null }> {
    const ceiling = stopAfter === null ? MAX_MATRIX_SCAN : MAX_LIST_SCAN;
    const items: Resolved[] = [];
    let after = filters.after;
    let lastScannedId: string | null = null;
    let scanned = 0;
    for (;;) {
      const candidates = await this.priorities.scanCandidates(tx, { ...filters, after }, SCAN_PAGE);
      if (candidates.length === 0) return { items, exhausted: true, lastScannedId };
      for (const candidate of candidates) {
        scanned += 1;
        after = candidate.itemId;
        lastScannedId = candidate.itemId;
        const row = toResolved(candidate);
        if (matches(row)) items.push(row);
        if (stopAfter !== null && items.length >= stopAfter) {
          return { items, exhausted: false, lastScannedId };
        }
        if (scanned >= ceiling) return { items, exhausted: false, lastScannedId };
      }
      if (candidates.length < SCAN_PAGE) return { items, exhausted: true, lastScannedId };
    }
  }

  /** A key outside the ruleset or a value outside `true | false | null` is a client bug, not something to store. */
  private checkAnswers(raw: Record<string, boolean | null>): Answers {
    const known = new Set<string>(QUESTION_KEYS);
    const errors: FieldError[] = [];
    for (const [key, value] of Object.entries(raw)) {
      if (!known.has(key)) {
        errors.push({
          path: `answers.${key}`,
          code: 'unknownQuestion',
          message: 'Not a question of the priority ruleset.',
        });
      } else if (typeof value !== 'boolean' && value !== null) {
        errors.push({
          path: `answers.${key}`,
          code: 'isBoolean',
          message: 'Use true, false or null.',
        });
      }
    }
    if (errors.length > 0) throw validationFailed(errors);
    return cleanAnswers(raw);
  }
}

/** Only the filters the repository can apply; the quadrant is decided after the rule has run. */
const filtersOf = (query: PriorityListQueryDto): PriorityFilters => ({
  ...(query.businessUnitId ? { businessUnitId: query.businessUnitId } : {}),
  ...(query.frameworkId ? { frameworkId: query.frameworkId } : {}),
  ...(query.ownerMembershipId ? { ownerMembershipId: query.ownerMembershipId } : {}),
  ...(query.status ? { status: query.status } : {}),
  ...(query.q ? { q: query.q } : {}),
  ...(query.after ? { after: query.after } : {}),
});
