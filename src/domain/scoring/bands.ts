import type { Band, Methodology, RiskLevel } from './methodologies.js';
import { RISK_LEVELS } from './methodologies.js';

/**
 * An organisation changes where Low ends, where Medium ends and where High ends; the four band names and
 * the full range stay fixed, so the bands are contiguous and cover every possible score by construction.
 */
export interface BandThresholds {
  lowMax: number;
  mediumMax: number;
  highMax: number;
}

/** The upper thresholds of a band list (the bands of a methodology, in order). */
export function thresholdsOf(bands: readonly Band[]): BandThresholds {
  const max = (key: RiskLevel) => bands.find((band) => band.key === key)?.max ?? 0;
  return { lowMax: max('LOW'), mediumMax: max('MEDIUM'), highMax: max('HIGH') };
}

/** Builds the four bands for a methodology from thresholds (assumes they were validated). */
export function bandsFrom(methodology: Methodology, thresholds: BandThresholds): Band[] {
  const labels = new Map(methodology.defaultBands.map((band) => [band.key, band.label]));
  const { min, max } = methodology.range;
  return [
    { key: 'LOW', label: labels.get('LOW') ?? 'Low', min, max: thresholds.lowMax },
    {
      key: 'MEDIUM',
      label: labels.get('MEDIUM') ?? 'Medium',
      min: thresholds.lowMax + 1,
      max: thresholds.mediumMax,
    },
    {
      key: 'HIGH',
      label: labels.get('HIGH') ?? 'High',
      min: thresholds.mediumMax + 1,
      max: thresholds.highMax,
    },
    {
      key: 'CRITICAL',
      label: labels.get('CRITICAL') ?? 'Critical',
      min: thresholds.highMax + 1,
      max,
    },
  ];
}

/**
 * Problems with proposed thresholds, as `{ field, message }` (empty = valid). Thresholds must be whole numbers,
 * strictly increasing, and leave room for every band inside the methodology's range.
 */
export function validateThresholds(
  methodology: Methodology,
  thresholds: BandThresholds,
): { field: keyof BandThresholds; message: string }[] {
  const problems: { field: keyof BandThresholds; message: string }[] = [];
  const { min, max } = methodology.range;
  const fields: (keyof BandThresholds)[] = ['lowMax', 'mediumMax', 'highMax'];
  for (const field of fields) {
    const value = thresholds[field];
    if (!Number.isInteger(value)) {
      problems.push({ field, message: 'Use a whole number.' });
    } else if (value < min || value >= max) {
      problems.push({ field, message: `Use a value from ${min} to ${max - 1}.` });
    }
  }
  if (problems.length > 0) return problems;
  if (thresholds.mediumMax <= thresholds.lowMax) {
    problems.push({ field: 'mediumMax', message: 'Medium must end above where Low ends.' });
  }
  if (thresholds.highMax <= thresholds.mediumMax) {
    problems.push({ field: 'highMax', message: 'High must end above where Medium ends.' });
  }
  return problems;
}

/** The band a score falls in, or null when there is no score (unassessed is never a band). */
export function bandFor(score: number | null, bands: readonly Band[]): Band | null {
  if (score === null) return null;
  return bands.find((band) => score >= band.min && score <= band.max) ?? null;
}

/** The order of the levels, lowest first (for sorting and "High or Critical" counts). */
export const levelRank = (level: RiskLevel): number => RISK_LEVELS.indexOf(level);
