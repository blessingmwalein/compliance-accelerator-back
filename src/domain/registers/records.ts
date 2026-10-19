/**
 * The vocabularies of the Phase 6 registers, as the pure unions the services and repositories use.
 * They mirror the Prisma enums in `prisma/schema.prisma`; a row read from the database is assignable to
 * these, and a value written is checked here first, so an unknown literal is a compile error.
 */

/** A processing activity: drafted, in force, or archived (archive is a status, not a second flag). */
export const ROPA_STATUSES = ['DRAFT', 'ACTIVE', 'ARCHIVED'] as const;
export type RopaActivityStatus = (typeof ROPA_STATUSES)[number];

/** Article 6 bases. The list is the six, closed: nothing outside it is a lawful basis. */
export const LAWFUL_BASES = [
  'CONSENT',
  'CONTRACT',
  'LEGAL_OBLIGATION',
  'VITAL_INTERESTS',
  'PUBLIC_TASK',
  'LEGITIMATE_INTEREST',
] as const;
export type LawfulBasisKind = (typeof LAWFUL_BASES)[number];

/**
 * How far a basis has been checked. Only an APPROVED basis claims to justify its processing, and the
 * approval is a person's decision with a written justification (the database CHECK enforces the pair).
 */
export const LAWFUL_BASIS_REVIEW_STATUSES = ['DRAFT', 'UNDER_REVIEW', 'APPROVED'] as const;
export type LawfulBasisReviewStatus = (typeof LAWFUL_BASIS_REVIEW_STATUSES)[number];

export interface BasisReviewTransition {
  from: LawfulBasisReviewStatus;
  to: LawfulBasisReviewStatus;
  /** `approve`: only an approver may sign the basis off; `work`: anyone who may edit the register. */
  by: 'work' | 'approve';
  /** A written justification is mandatory (approval, and saying why an approval was taken back). */
  needsReason: boolean;
}

const t = (
  from: LawfulBasisReviewStatus,
  to: LawfulBasisReviewStatus,
  by: BasisReviewTransition['by'] = 'work',
  needsReason = false,
): BasisReviewTransition => ({ from, to, by, needsReason });

export const BASIS_REVIEW_TRANSITIONS: readonly BasisReviewTransition[] = [
  t('DRAFT', 'UNDER_REVIEW'),
  t('DRAFT', 'APPROVED', 'approve', true),
  t('UNDER_REVIEW', 'APPROVED', 'approve', true),
  // an approval is only taken back by an approver, and the record has to say why
  t('UNDER_REVIEW', 'DRAFT'),
  t('APPROVED', 'UNDER_REVIEW', 'approve', true),
  t('APPROVED', 'DRAFT', 'approve', true),
];

export function findBasisReviewTransition(
  from: LawfulBasisReviewStatus,
  to: LawfulBasisReviewStatus,
): BasisReviewTransition | undefined {
  return BASIS_REVIEW_TRANSITIONS.find(
    (transition) => transition.from === from && transition.to === to,
  );
}

/** The moves available from one review status (so the UI never offers a forbidden one). */
export const nextBasisReviewStatuses = (from: LawfulBasisReviewStatus): BasisReviewTransition[] =>
  BASIS_REVIEW_TRANSITIONS.filter((transition) => transition.from === from);

/** What starts the clock on a retention rule. `OTHER` requires the rule to say what it is. */
export const RETENTION_TRIGGERS = [
  'CONTRACT_END',
  'DATA_NO_LONGER_NEEDED',
  'REGULATORY_PERIOD',
  'SUBJECT_REQUEST',
  'LAST_USE',
  'OTHER',
] as const;
export type RetentionTriggerEvent = (typeof RETENTION_TRIGGERS)[number];

/** What a legal hold protects: the four things the registers can dispose of. */
export const DISPOSAL_TARGETS = [
  'EVIDENCE',
  'ROPA_ACTIVITY',
  'LAWFUL_BASIS_RECORD',
  'RETENTION_RULE',
] as const;
export type DisposalTarget = (typeof DISPOSAL_TARGETS)[number];
