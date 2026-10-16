/**
 * Named, versioned scoring methodologies (skill grc-domain). Nothing outside this file knows a threshold:
 * services pass the bands in force, and stored results record the methodology id, its version and a band
 * snapshot. The reference app's thresholds are DEFAULTS an organisation may change (see `bands.ts`); they are
 * not a legal or regulatory standard.
 */

export const RISK_LEVELS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export interface Band {
  key: RiskLevel;
  label: string;
  /** Inclusive lower and upper bound of the score range this band covers. */
  min: number;
  max: number;
}

export type MethodologyId = 'exposure_v1' | 'risk_matrix_v1' | 'maturity_v1';

export interface Methodology {
  id: MethodologyId;
  version: number;
  label: string;
  formula: string;
  /** Smallest and largest score the formula can produce. */
  range: { min: number; max: number };
  /** The reference bands (an organisation may override them; `bands.ts`). */
  defaultBands: readonly Band[];
}

const band = (key: RiskLevel, label: string, min: number, max: number): Band => ({
  key,
  label,
  min,
  max,
});

/** Governance area / assessment item: sensitivity x severity x likelihood, each 1 to 5. */
export const EXPOSURE_V1: Methodology = {
  id: 'exposure_v1',
  version: 1,
  label: 'Risk exposure (sensitivity × severity × likelihood)',
  formula: 'sensitivity × severity × likelihood',
  range: { min: 1, max: 125 },
  defaultBands: [
    band('LOW', 'Low', 1, 25),
    band('MEDIUM', 'Medium', 26, 60),
    band('HIGH', 'High', 61, 90),
    band('CRITICAL', 'Critical', 91, 125),
  ],
};

/** Risk register and heatmap (Phase 6): likelihood x severity, each 1 to 5. */
export const RISK_MATRIX_V1: Methodology = {
  id: 'risk_matrix_v1',
  version: 1,
  label: 'Risk matrix (likelihood × severity)',
  formula: 'likelihood × severity',
  range: { min: 1, max: 25 },
  defaultBands: [
    band('LOW', 'Low', 1, 5),
    band('MEDIUM', 'Medium', 6, 11),
    band('HIGH', 'High', 12, 19),
    band('CRITICAL', 'Critical', 20, 25),
  ],
};

/** The 1 to 5 scales. Labels are the reference defaults; the number is what is stored. */
export const SCALE_MIN = 1;
export const SCALE_MAX = 5;

export const MATURITY_LABELS: Readonly<Record<number, string>> = {
  1: 'Initial',
  2: 'Managed',
  3: 'Defined',
  4: 'Quantitatively Managed',
  5: 'Optimizing',
};
export const SENSITIVITY_LABELS: Readonly<Record<number, string>> = {
  1: 'Public',
  2: 'Internal',
  3: 'Confidential',
  4: 'Restricted',
  5: 'Critical',
};
export const SEVERITY_LABELS: Readonly<Record<number, string>> = {
  1: 'Minimal',
  2: 'Minor',
  3: 'Moderate',
  4: 'Major',
  5: 'Catastrophic',
};
export const LIKELIHOOD_LABELS: Readonly<Record<number, string>> = {
  1: 'Rare',
  2: 'Unlikely',
  3: 'Possible',
  4: 'Likely',
  5: 'Almost certain',
};

/** The maturity methodology: current and target on the 1 to 5 scale, gap in LEVELS (never a percentage). */
export const MATURITY_V1 = { id: 'maturity_v1', version: 1, label: 'Maturity gap (levels)' } as const;

/** The attainable products of three 1 to 5 factors (nothing exists between 81 and 99: shown to band editors). */
export function attainableExposureValues(): number[] {
  const values = new Set<number>();
  for (let a = SCALE_MIN; a <= SCALE_MAX; a++) {
    for (let b = SCALE_MIN; b <= SCALE_MAX; b++) {
      for (let c = SCALE_MIN; c <= SCALE_MAX; c++) values.add(a * b * c);
    }
  }
  return [...values].sort((x, y) => x - y);
}
