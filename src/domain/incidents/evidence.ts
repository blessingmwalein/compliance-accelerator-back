/**
 * The evidence repository's review and scan vocabularies (AC-EVD-01). They mirror the Prisma enums in
 * `prisma/schema.prisma`; the file's own bytes live in the append-only `evidence_versions` ledger and the
 * row carries only which version is current.
 *
 * The calendar state of a review (`nextReviewDate`) is NOT computed here: it comes from
 * `src/domain/registers/review.ts`, the same four states every other reviewed record uses.
 */
export const EVIDENCE_REVIEW_STATUSES = [
  'UNREVIEWED',
  'UNDER_REVIEW',
  'ACCEPTED',
  'REJECTED',
] as const;
export type EvidenceReviewStatus = (typeof EVIDENCE_REVIEW_STATUSES)[number];

/**
 * Scan state of the CURRENT version, attested by a named person. The platform runs no scanner: `CLEAN` is
 * somebody's statement about a check made elsewhere, recorded with the date it was made — which is why the
 * database pairs a state with a date and an author, and why a new version resets the row to `NOT_SCANNED`.
 */
export const EVIDENCE_SCAN_STATES = ['NOT_SCANNED', 'CLEAN', 'INFECTED', 'UNABLE_TO_SCAN'] as const;
export type EvidenceScanState = (typeof EVIDENCE_SCAN_STATES)[number];

/** Anything but `NOT_SCANNED` is an attestation: dated, attributed, and refused without both. */
export const isScanAttested = (state: EvidenceScanState): boolean => state !== 'NOT_SCANNED';

/** A bad result has to say what it found; a clean one does not need an explanation. */
export const scanNoteRequired = (state: EvidenceScanState): boolean =>
  state === 'INFECTED' || state === 'UNABLE_TO_SCAN';

/** An outcome is a person's decision; `UNREVIEWED` and `UNDER_REVIEW` are not judgements. */
export const isReviewOutcome = (status: EvidenceReviewStatus): boolean =>
  status === 'ACCEPTED' || status === 'REJECTED';

export interface EvidenceReviewTransition {
  from: EvidenceReviewStatus;
  to: EvidenceReviewStatus;
  /** `approve`: only an approver may accept or reject content; `work`: anyone who may edit the repository. */
  by: 'work' | 'approve';
  /** A written reason is mandatory. */
  needsReason: boolean;
}

const t = (
  from: EvidenceReviewStatus,
  to: EvidenceReviewStatus,
  by: EvidenceReviewTransition['by'] = 'work',
  needsReason = false,
): EvidenceReviewTransition => ({ from, to, by, needsReason });

export const EVIDENCE_REVIEW_TRANSITIONS: readonly EvidenceReviewTransition[] = [
  t('UNREVIEWED', 'UNDER_REVIEW'),
  t('UNREVIEWED', 'ACCEPTED', 'approve'),
  t('UNREVIEWED', 'REJECTED', 'approve', true),
  t('UNDER_REVIEW', 'ACCEPTED', 'approve'),
  t('UNDER_REVIEW', 'REJECTED', 'approve', true),
  // taking an outcome back: a rejection that was fixed goes back for a look, and an acceptance is only
  // withdrawn by the person who could grant it, with the reason on the record
  t('REJECTED', 'UNDER_REVIEW'),
  t('ACCEPTED', 'UNDER_REVIEW', 'approve', true),
  t('ACCEPTED', 'REJECTED', 'approve', true),
];

export function findEvidenceReviewTransition(
  from: EvidenceReviewStatus,
  to: EvidenceReviewStatus,
): EvidenceReviewTransition | undefined {
  return EVIDENCE_REVIEW_TRANSITIONS.find(
    (transition) => transition.from === from && transition.to === to,
  );
}

/** The moves available from one review status. */
export const nextEvidenceReviewStatuses = (
  from: EvidenceReviewStatus,
): EvidenceReviewTransition[] =>
  EVIDENCE_REVIEW_TRANSITIONS.filter((transition) => transition.from === from);
