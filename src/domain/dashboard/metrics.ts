import { bandFor } from '../scoring/bands.js';
import type { Band, RiskLevel } from '../scoring/methodologies.js';
import { mean, type Measured, type SummaryInput } from '../scoring/scoring.js';
import type { TaskStatus } from '../remediation/policy.js';

/**
 * The organisation-wide dashboard metrics (Phase 8): which assessment work counts as the organisation's
 * finding, how a set of items rolls up into a maturity/exposure/gap figure, and what a getting-started
 * step means. Pure — no Nest, no Prisma (skill grc-domain).
 *
 * The dashboard shows nothing that is not decided here or by the module that owns the number. A register,
 * RoPA, DSAR, breach or priority count is NOT recomputed here: those endpoints answer for themselves
 * (`docs/metrics/README.md` — "the dashboard's cards are the counts above, not recomputed ones").
 */

/** The availability every dashboard metric answers with; `status` is only meaningful when it is `ok`. */
export const METRIC_AVAILABILITIES = [
  'ok',
  'no_records',
  'not_configured',
  'not_assessed',
  'unable_to_calculate',
] as const;
export type MetricAvailability = (typeof METRIC_AVAILABILITIES)[number];

/** The verdict word of an `ok` metric. `compliant` is shown as "Meets target", never as a legal claim. */
export const METRIC_STATUSES = ['compliant', 'needs_attention', 'in_progress'] as const;
export type MetricStatus = (typeof METRIC_STATUSES)[number];

/**
 * The gap, in maturity levels, at which an area is highlighted. The definition sheet's default; a client
 * never hard-codes it, because the report and the screen must highlight the same rows.
 */
export const GAP_HIGHLIGHT_LEVELS = 2;

/** A finding is outstanding while its task is still work: a completed or cancelled task says nothing new. */
export const OUTSTANDING_TASK_STATUSES: readonly TaskStatus[] = ['OPEN', 'IN_PROGRESS', 'BLOCKED'];

/**
 * Only a submitted or an approved cycle is the organisation's finding: a DRAFT is somebody's work in
 * progress, and a SUPERSEDED cycle is the older revision of work that has since been re-signed.
 */
export const ELIGIBLE_CYCLE_STATUSES: ReadonlySet<string> = new Set(['IN_REVIEW', 'APPROVED']);

/** An assessment cycle, as far as the dashboard cares: its state and the methodology it froze. */
export interface CycleRow {
  id: string;
  /** A cycle status; compare against `ELIGIBLE_CYCLE_STATUSES`. */
  status: string;
  methodologyId: string;
  methodologyVersion: number;
  submittedAt: Date | null;
  approvedAt: Date | null;
  createdAt: Date;
}

/** One assessed subject with its stored derivations. `targetMaturity` is the roll-up's other side. */
export interface ItemRow extends SummaryInput {
  id: string;
  assessmentId: string;
  governanceAreaId: string | null;
  requirementId: string | null;
  businessUnitId: string | null;
  frameworkId: string | null;
  targetMaturity: number | null;
}

/** An item that counts, together with the cycle it comes from. */
export interface EligibleItem extends ItemRow {
  cycleId: string;
  methodologyId: string;
  methodologyVersion: number;
}

/**
 * The instant a revision was stood behind: its approval, else its submission, else its creation. The
 * newest of these per subject is the organisation's current answer for that subject.
 */
export const revisionInstantOf = (cycle: CycleRow): Date =>
  cycle.approvedAt ?? cycle.submittedAt ?? cycle.createdAt;

/**
 * What one item assesses. A requirement is a control of a framework; an area-only item is the organisation's
 * reading of that area, and the same area for another business unit is a different subject. An item with
 * neither is an ad-hoc subject and never replaces another one.
 */
export function subjectKeyOf(item: ItemRow): string {
  if (item.requirementId !== null) return `requirement:${item.requirementId}`;
  if (item.governanceAreaId !== null) {
    return `area:${item.governanceAreaId}|unit:${item.businessUnitId ?? 'organisation'}`;
  }
  return `item:${item.id}`;
}

/**
 * The organisation's current answers: one item per subject, taken from the newest eligible cycle.
 * Ties on the revision instant break on the cycle's creation date and then its id (UUIDv7, so id order
 * is creation order) — a stable answer, not a coin toss. The caller's own row type is carried through,
 * so the names it read alongside the figures survive the roll-up.
 */
export function eligibleItems<T extends ItemRow>(
  items: readonly T[],
  cycles: readonly CycleRow[],
): (T & EligibleItem)[] {
  const byId = new Map(cycles.map((cycle) => [cycle.id, cycle]));
  const newest = new Map<string, { item: T & EligibleItem; instant: number; created: number }>();
  for (const item of items) {
    const cycle = byId.get(item.assessmentId);
    if (!cycle || !ELIGIBLE_CYCLE_STATUSES.has(cycle.status)) continue;
    const eligible: T & EligibleItem = {
      ...item,
      cycleId: cycle.id,
      methodologyId: cycle.methodologyId,
      methodologyVersion: cycle.methodologyVersion,
    };
    const held = newest.get(subjectKeyOf(item));
    const entry = {
      item: eligible,
      instant: revisionInstantOf(cycle).getTime(),
      created: cycle.createdAt.getTime(),
    };
    if (
      held === undefined ||
      entry.instant > held.instant ||
      (entry.instant === held.instant &&
        (entry.created > held.created ||
          (entry.created === held.created && eligible.cycleId > held.item.cycleId)))
    ) {
      newest.set(subjectKeyOf(item), entry);
    }
  }
  return [...newest.values()]
    .map((entry) => entry.item)
    .sort((a, b) => subjectKeyOf(a).localeCompare(subjectKeyOf(b)));
}

/** The methodologies the set was scored under. More than one pair and no exposure mean may be drawn. */
export function methodologiesOf(items: readonly EligibleItem[]): { id: string; version: number }[] {
  const seen = new Map<string, { id: string; version: number }>();
  for (const item of items) {
    const key = `${item.methodologyId}@${item.methodologyVersion}`;
    if (!seen.has(key)) seen.set(key, { id: item.methodologyId, version: item.methodologyVersion });
  }
  return [...seen.values()].sort((a, b) => a.id.localeCompare(b.id) || a.version - b.version);
}

/** Maturity, target and gap of one set of subjects, with the status rule of the definition sheet. */
export interface MaturityRoll {
  availability: 'ok' | 'not_assessed';
  /** Mean `currentMaturity` over the subjects that carry one. */
  current: Measured;
  /** Mean `targetMaturity` over the subjects that carry one. */
  target: Measured;
  /** Mean `gap` (target minus current, never below zero) over the subjects that have both. */
  gap: Measured;
  /** The subjects in the set: the denominator every coverage pair above is taken against. */
  applicable: number;
  status: MetricStatus | null;
}

const measuredOf = (values: readonly number[], applicable: number): Measured => ({
  value: mean(values),
  assessed: values.length,
  applicable,
});

/**
 * `compliant` only when every subject that has both sides already meets its target; `needs_attention` as
 * soon as one of them is short by the highlight gap; `in_progress` in between. Null when nothing is rated:
 * an unassessed register is not a verdict.
 */
export function maturityRoll(items: readonly EligibleItem[]): MaturityRoll {
  const applicable = items.length;
  const current = measuredOf(
    items.flatMap((item) => (item.currentMaturity === null ? [] : [item.currentMaturity])),
    applicable,
  );
  const target = measuredOf(
    items.flatMap((item) => (item.targetMaturity === null ? [] : [item.targetMaturity])),
    applicable,
  );
  const gaps = items.flatMap((item) => (item.gap === null ? [] : [item.gap]));
  const status: MetricStatus | null =
    gaps.length === 0
      ? null
      : gaps.some((gap) => gap >= GAP_HIGHLIGHT_LEVELS)
        ? 'needs_attention'
        : gaps.every((gap) => gap === 0)
          ? 'compliant'
          : 'in_progress';
  return {
    availability: current.assessed === 0 ? 'not_assessed' : 'ok',
    current,
    target,
    gap: measuredOf(gaps, applicable),
    applicable,
    status,
  };
}

/** The exposure mean of a set, its band under the bands in force, and why it may refuse to answer. */
export interface ExposureRoll {
  availability: 'ok' | 'no_records' | 'not_assessed' | 'unable_to_calculate';
  /** The methodologies the set spans; more than one entry whenever `availability` is `unable_to_calculate`. */
  methodologies: { id: string; version: number }[];
  mean: Measured;
  /** The band the mean falls in, under the bands in force today; null when there is no mean. */
  band: Band | null;
  /** Rated subjects per band; null when the bands the ratings were made under differ per item. */
  byRiskLevel: Record<RiskLevel, number> | null;
  status: MetricStatus | null;
}

const emptyLevels = (): Record<RiskLevel, number> => ({
  LOW: 0,
  MEDIUM: 0,
  HIGH: 0,
  CRITICAL: 0,
});

/**
 * `risk.exposure.overall`. One methodology only: exposure scores made under different bands are not one
 * average. The band of the mean is the organisation's policy in force today, because this figure is the
 * organisation's position now rather than a signed-off document's.
 */
export function exposureRoll(items: readonly EligibleItem[], bands: readonly Band[]): ExposureRoll {
  const methodologies = methodologiesOf(items);
  const applicable = items.length;
  const exposures = items.flatMap((item) => (item.exposure === null ? [] : [item.exposure]));
  if (methodologies.length > 1) {
    return {
      availability: 'unable_to_calculate',
      methodologies,
      mean: { value: null, assessed: 0, applicable },
      band: null,
      byRiskLevel: null,
      status: null,
    };
  }
  if (applicable === 0) {
    return {
      availability: 'no_records',
      methodologies,
      mean: { value: null, assessed: 0, applicable: 0 },
      band: null,
      byRiskLevel: emptyLevels(),
      status: null,
    };
  }
  if (exposures.length === 0) {
    return {
      availability: 'not_assessed',
      methodologies,
      mean: { value: null, assessed: 0, applicable },
      band: null,
      byRiskLevel: emptyLevels(),
      status: null,
    };
  }
  const average = mean(exposures);
  const band = bandFor(average, bands);
  const byRiskLevel = emptyLevels();
  for (const item of items) if (item.riskLevel) byRiskLevel[item.riskLevel] += 1;
  return {
    availability: 'ok',
    methodologies,
    mean: { value: average, assessed: exposures.length, applicable },
    band,
    byRiskLevel,
    status:
      band === null
        ? null
        : band.key === 'LOW'
          ? 'compliant'
          : band.key === 'MEDIUM'
            ? 'in_progress'
            : 'needs_attention',
  };
}

/** How a set of subjects sits against its targets: met, short by less than the highlight, short by more. */
export interface GapBands {
  met: number;
  minor: number;
  major: number;
  /** Subjects with a missing side, so no gap can be stated. Counted, never dropped. */
  unmeasured: number;
}

export function gapBandsOf(
  items: readonly EligibleItem[],
  highlightAt: number = GAP_HIGHLIGHT_LEVELS,
): GapBands {
  const bands: GapBands = { met: 0, minor: 0, major: 0, unmeasured: 0 };
  for (const item of items) {
    if (item.gap === null) bands.unmeasured += 1;
    else if (item.gap === 0) bands.met += 1;
    else if (item.gap < highlightAt) bands.minor += 1;
    else bands.major += 1;
  }
  return bands;
}

/** The fields a top-risk ranking reads. Scores and levels are the register's own stored derivations. */
export interface TopRiskSortRow {
  id: string;
  title: string;
  reviewByDate: string | null;
  inherentScore: number | null;
  inherentSeverity: number | null;
  residualScore: number | null;
  residualSeverity: number | null;
}

/**
 * `risk.top`: exposure descending, then severity, then the earliest next-action date (the date the register
 * says the risk next needs a look — an unscheduled risk is not "soonest" and not "never"), then the name.
 * An unscored risk cannot rank above a scored one: it has no exposure to rank by.
 */
export function topRisks<T extends TopRiskSortRow>(
  rows: readonly T[],
  basis: 'residual' | 'inherent',
  limit: number,
): T[] {
  const scoreOf = (row: T) => (basis === 'inherent' ? row.inherentScore : row.residualScore);
  const severityOf = (row: T) =>
    basis === 'inherent' ? row.inherentSeverity : row.residualSeverity;
  return [...rows]
    .sort((a, b) => {
      const [left, right] = [scoreOf(a), scoreOf(b)];
      if (left !== right) {
        if (left === null) return 1;
        if (right === null) return -1;
        return right - left;
      }
      const [leftSeverity, rightSeverity] = [severityOf(a), severityOf(b)];
      if (leftSeverity !== rightSeverity) {
        if (leftSeverity === null) return 1;
        if (rightSeverity === null) return -1;
        return rightSeverity - leftSeverity;
      }
      if (a.reviewByDate !== b.reviewByDate) {
        if (a.reviewByDate === null) return 1;
        if (b.reviewByDate === null) return -1;
        return a.reviewByDate.localeCompare(b.reviewByDate);
      }
      return a.title.localeCompare(b.title);
    })
    .slice(0, Math.max(0, limit));
}

/** What the six getting-started steps ask the data, before any wording is attached to them. */
export interface OnboardingFacts {
  /** The organisation's name, country and DPO contact email are all filled in. */
  companyDetails: boolean;
  /** At least one business unit exists. */
  businessUnits: boolean;
  /** At least one assessment cycle has been submitted or approved. */
  submittedAssessment: boolean;
  /** At least one RoPA activity exists. */
  ropaRecords: boolean;
  /** At least one RoPA activity carries a classification level. */
  classifiedData: boolean;
  /** Frameworks are declared applicable and at least one mapping has been reviewed and approved. */
  mappingReviewed: boolean;
}

/** The six steps, in order, with the wording the screen and the PDF both show. */
export const ONBOARDING_STEPS: Readonly<
  Record<keyof OnboardingFacts, Pick<OnboardingStep, 'title' | 'description'>>
> = {
  companyDetails: {
    title: 'Set up your company',
    description: 'Add the company details, the country and the data protection contact.',
  },
  businessUnits: {
    title: 'Define business units',
    description: 'Record the parts of the organisation the work is filed under.',
  },
  submittedAssessment: {
    title: 'Run a governance assessment',
    description: 'Rate your controls and submit the cycle for review.',
  },
  ropaRecords: {
    title: 'Build your record of processing',
    description: 'List the processing activities the organisation carries.',
  },
  classifiedData: {
    title: 'Classify your data',
    description: 'Give at least one processing activity a classification level.',
  },
  mappingReviewed: {
    title: 'Review compliance mapping',
    description: 'Choose your frameworks and have at least one mapping approved.',
  },
};

/** One step of the panel: the server's own wording and whether the saved data says it is done. */
export interface OnboardingStep {
  key: keyof OnboardingFacts;
  title: string;
  description: string;
  done: boolean;
}

/**
 * `onboarding.progress`: six steps derived from saved data, never a stored flag. A step is complete when
 * the record exists, not when somebody says the panel is finished.
 */
export function onboardingOf(facts: OnboardingFacts): {
  steps: OnboardingStep[];
  completed: number;
} {
  const steps = (Object.keys(ONBOARDING_STEPS) as (keyof OnboardingFacts)[]).map((key) => ({
    key,
    ...ONBOARDING_STEPS[key],
    done: facts[key],
  }));
  return { steps, completed: steps.filter((step) => step.done).length };
}
