import { bandFor } from './bands.js';
import type { Band, RiskLevel } from './methodologies.js';
import { SCALE_MAX, SCALE_MIN } from './methodologies.js';

/** A rating on a 1 to 5 scale: whole numbers only. */
export const isScale = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= SCALE_MIN && value <= SCALE_MAX;

/**
 * Maturity gap in LEVELS: target minus current, never below 0 (a control above its target has no gap).
 * Null when either side is not assessed: a missing value is never replaced by a default.
 */
export function maturityGap(current: number | null, target: number | null): number | null {
  if (current === null || target === null) return null;
  return Math.max(0, target - current);
}

export interface ExposureInput {
  sensitivity: number | null;
  severity: number | null;
  likelihood: number | null;
}

/** Sensitivity x severity x likelihood, or null (with the missing names) when any factor is not rated. */
export function exposureScore(input: ExposureInput): number | null {
  const { sensitivity, severity, likelihood } = input;
  if (sensitivity === null || severity === null || likelihood === null) return null;
  return sensitivity * severity * likelihood;
}

export interface ScoredInputs extends ExposureInput {
  currentMaturity: number | null;
  targetMaturity: number | null;
}

export interface Scores {
  gap: number | null;
  exposure: number | null;
  riskLevel: RiskLevel | null;
}

/** Everything derived from an item's ratings under the bands in force. */
export function scoreItem(inputs: ScoredInputs, bands: readonly Band[]): Scores {
  const exposure = exposureScore(inputs);
  return {
    gap: maturityGap(inputs.currentMaturity, inputs.targetMaturity),
    exposure,
    riskLevel: bandFor(exposure, bands)?.key ?? null,
  };
}

/** A value with the coverage it is based on: how many of the applicable records were assessed. */
export interface Measured {
  /** Null when nothing was assessed. */
  value: number | null;
  assessed: number;
  applicable: number;
}

export interface SummaryInput {
  currentMaturity: number | null;
  gap: number | null;
  exposure: number | null;
  riskLevel: RiskLevel | null;
}

export interface Summary {
  averageMaturity: Measured;
  averageGap: Measured;
  averageExposure: Measured;
  /** Items rated High or Critical. `value` is a count (null when nothing was rated). */
  highOrCritical: Measured;
  byRiskLevel: Record<RiskLevel, number>;
  /** Items with no exposure rating yet. */
  notRated: number;
}

const mean = (values: readonly number[]): number | null =>
  values.length === 0
    ? null
    : Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 100) / 100;

/**
 * Roll-up of a set of items. Unassessed items are DROPPED from every average and counted in `applicable`
 * only: an empty set is "not assessed" (null), never zero, and every value carries its coverage.
 */
export function summarise(items: readonly SummaryInput[]): Summary {
  const applicable = items.length;
  const maturities = items.flatMap((item) => (item.currentMaturity === null ? [] : [item.currentMaturity]));
  const gaps = items.flatMap((item) => (item.gap === null ? [] : [item.gap]));
  const exposures = items.flatMap((item) => (item.exposure === null ? [] : [item.exposure]));
  const byRiskLevel: Record<RiskLevel, number> = { LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: 0 };
  for (const item of items) if (item.riskLevel) byRiskLevel[item.riskLevel] += 1;
  return {
    averageMaturity: { value: mean(maturities), assessed: maturities.length, applicable },
    averageGap: { value: mean(gaps), assessed: gaps.length, applicable },
    averageExposure: { value: mean(exposures), assessed: exposures.length, applicable },
    highOrCritical: {
      value: exposures.length === 0 ? null : byRiskLevel.HIGH + byRiskLevel.CRITICAL,
      assessed: exposures.length,
      applicable,
    },
    byRiskLevel,
    notRated: applicable - exposures.length,
  };
}
