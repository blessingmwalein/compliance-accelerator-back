import { bandFor } from '../scoring/bands.js';
import { RISK_MATRIX_V1, type RiskLevel } from '../scoring/methodologies.js';

/**
 * The risk register: its status lifecycle, its categories, and the `risk_matrix_v1` arithmetic
 * (likelihood × severity, each 1 to 5). Pure — no Nest, no Prisma (skill grc-domain).
 *
 * Phase 6 uses the REFERENCE bands (Low 1-5, Medium 6-11, High 12-19, Critical 20-25) for every
 * organisation; making them configurable per organisation is a deviation recorded in the plan. The band
 * stored on a row is therefore derivable from its score, which is exactly what the database CHECK does too.
 */

export const RISK_STATUSES = ['OPEN', 'IN_TREATMENT', 'ACCEPTED', 'TRANSFERRED', 'CLOSED'] as const;
export type RiskStatus = (typeof RISK_STATUSES)[number];

/** A status whose risk still needs somebody to do something about it. */
export const OPEN_STATUSES: readonly RiskStatus[] = ['OPEN', 'IN_TREATMENT'];

export const RISK_CATEGORIES = [
  'DATA_PRIVACY',
  'CYBERSECURITY',
  'OPERATIONAL',
  'REGULATORY',
  'THIRD_PARTY',
  'PHYSICAL',
  'REPUTATIONAL',
  'FINANCIAL',
] as const;
export type RiskCategory = (typeof RISK_CATEGORIES)[number];

export const ACCEPTANCE_DECISIONS = ['ACCEPTED', 'WITHDRAWN'] as const;
export type AcceptanceDecision = (typeof ACCEPTANCE_DECISIONS)[number];

export interface RiskTransition {
  from: RiskStatus;
  to: RiskStatus;
  /** Who may do it: an editor of register content (`work`), or only an approver (`approve`). */
  by: 'work' | 'approve';
  /** A written reason is mandatory. */
  needsReason: boolean;
}

const t = (
  from: RiskStatus,
  to: RiskStatus,
  by: RiskTransition['by'] = 'work',
  needsReason = false,
): RiskTransition => ({ from, to, by, needsReason });

/**
 * Moving a risk to ACCEPTED is not a step here: acceptance is a decision recorded in the ledger
 * (`POST …/acceptances`), which is what sets the status. So `ACCEPTED` only ever has ways OUT.
 */
export const RISK_TRANSITIONS: readonly RiskTransition[] = [
  t('OPEN', 'IN_TREATMENT'),
  t('OPEN', 'TRANSFERRED'),
  t('OPEN', 'CLOSED'),
  t('IN_TREATMENT', 'OPEN'),
  t('IN_TREATMENT', 'TRANSFERRED'),
  t('IN_TREATMENT', 'CLOSED'),
  // an accepted risk is only reopened by an approver, and saying why
  t('ACCEPTED', 'OPEN', 'approve', true),
  t('ACCEPTED', 'IN_TREATMENT', 'approve', true),
  t('ACCEPTED', 'TRANSFERRED', 'approve'),
  t('ACCEPTED', 'CLOSED', 'approve'),
  t('TRANSFERRED', 'OPEN'),
  t('TRANSFERRED', 'IN_TREATMENT'),
  t('TRANSFERRED', 'CLOSED'),
  // closing a risk is work; reopening one that was closed is an approver's decision with a reason
  t('CLOSED', 'OPEN', 'approve', true),
  t('CLOSED', 'IN_TREATMENT', 'approve', true),
];

export function findRiskTransition(from: RiskStatus, to: RiskStatus): RiskTransition | undefined {
  return RISK_TRANSITIONS.find((transition) => transition.from === from && transition.to === to);
}

/** Statuses a risk in `from` may move to (so the UI shows only the real actions). */
export const nextRiskStatuses = (from: RiskStatus): RiskTransition[] =>
  RISK_TRANSITIONS.filter((transition) => transition.from === from);

/** The bands in force: the reference bands of `risk_matrix_v1`, fixed for this phase. */
export const RISK_BANDS = RISK_MATRIX_V1.defaultBands;

/** One 1-5 factor, or null for "not scored". Returns null when either side is missing. */
export function riskScoreOf(
  likelihood: number | null,
  severity: number | null,
): { score: number; level: RiskLevel } | null {
  if (likelihood === null || severity === null) return null;
  const score = likelihood * severity;
  const band = bandFor(score, RISK_BANDS);
  if (!band) return null; // unreachable with 1-5 factors; never invent a band
  return { score, level: band.key };
}

/** A factor of the matrix: a whole number from 1 to 5, or null. */
export const isRiskFactor = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 5;

/**
 * Residual risk may only reduce inherent risk: both factors have to be scored, the inherent pair has to
 * exist, and neither residual factor may exceed its inherent counterpart.
 */
export function residualWithinInherent(
  inherent: { likelihood: number | null; severity: number | null },
  residual: { likelihood: number | null; severity: number | null },
): boolean {
  if (residual.likelihood === null && residual.severity === null) return true;
  if (inherent.likelihood === null || inherent.severity === null) return false;
  if (residual.likelihood === null || residual.severity === null) return false;
  return residual.likelihood <= inherent.likelihood && residual.severity <= inherent.severity;
}

/** The five by five matrix, as the API returns it: one cell per (likelihood, severity) pair. */
export const MATRIX_SIZE = 5;

export interface HeatmapCell {
  likelihood: number;
  severity: number;
  count: number;
  level: RiskLevel | null;
}

/** The empty grid (every cell zero), so a register with no risks still renders a matrix. */
export function emptyHeatmap(): HeatmapCell[] {
  const cells: HeatmapCell[] = [];
  for (let likelihood = 1; likelihood <= MATRIX_SIZE; likelihood++) {
    for (let severity = 1; severity <= MATRIX_SIZE; severity++) {
      const scored = riskScoreOf(likelihood, severity);
      cells.push({ likelihood, severity, count: 0, level: scored?.level ?? null });
    }
  }
  return cells;
}
