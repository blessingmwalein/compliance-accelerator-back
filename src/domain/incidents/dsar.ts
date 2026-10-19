/**
 * The data subject request lifecycle (AC-DSAR-01, skill grc-domain section 6). The vocabularies mirror the
 * Prisma enums in `prisma/schema.prisma`; a row read from the database is assignable to these, and a value
 * written is checked here first, so an unknown literal is a compile error.
 */
export const DSAR_REQUEST_TYPES = [
  'ACCESS',
  'RECTIFICATION',
  'ERASURE',
  'RESTRICTION',
  'PORTABILITY',
  'OBJECTION',
  'OTHER',
] as const;
export type DsarRequestType = (typeof DSAR_REQUEST_TYPES)[number];

export const DSAR_STATUSES = [
  'RECEIVED',
  'VERIFYING',
  'IN_PROGRESS',
  'ON_HOLD',
  'COMPLETED',
  'REFUSED',
  'WITHDRAWN',
] as const;
export type DsarStatus = (typeof DSAR_STATUSES)[number];

/** Whether the requester's identity has been proven. Nothing here is proven by the request having arrived. */
export const DSAR_IDENTITY_STATES = ['NOT_STARTED', 'REQUESTED', 'VERIFIED', 'FAILED'] as const;
export type DsarIdentityState = (typeof DSAR_IDENTITY_STATES)[number];

/** Who the entry is from: a message to the data subject, a message received, or an internal note. */
export const DSAR_COMMUNICATION_KINDS = ['OUTBOUND', 'INBOUND', 'NOTE'] as const;
export type DsarCommunicationKind = (typeof DSAR_COMMUNICATION_KINDS)[number];

/**
 * The three statuses that close a request. They are terminal for every rule here and in the database
 * trigger that refuses an extension afterwards, and each one is a dated, attributed decision with a
 * written outcome — never the absence of further work.
 */
export const TERMINAL_DSAR_STATUSES: readonly DsarStatus[] = ['COMPLETED', 'REFUSED', 'WITHDRAWN'];

export const isTerminalDsarStatus = (status: DsarStatus): boolean =>
  TERMINAL_DSAR_STATUSES.includes(status);

/** Still being worked: what the SLA metric counts as open and what an alert may still fire for. */
export const isOpenDsarStatus = (status: DsarStatus): boolean => !isTerminalDsarStatus(status);

/** The statuses a case worker moves between freely: who is doing what, and whether the clock is paused. */
const WORKING: readonly DsarStatus[] = ['RECEIVED', 'VERIFYING', 'IN_PROGRESS', 'ON_HOLD'];

export interface DsarTransition {
  from: DsarStatus;
  to: DsarStatus;
  /** `work`: whoever owns the case; `approve`: only an approver may end it. */
  by: 'work' | 'approve';
  /** A written outcome is mandatory (the database CHECK requires the pair). */
  needsNote: boolean;
  /** Proof has to be attached to the record before the move is allowed (AC-DSAR-01). */
  needsEvidence: boolean;
}

const t = (
  from: DsarStatus,
  to: DsarStatus,
  by: DsarTransition['by'] = 'work',
  needsNote = false,
  needsEvidence = false,
): DsarTransition => ({ from, to, by, needsNote, needsEvidence });

export const DSAR_TRANSITIONS: readonly DsarTransition[] = [
  // Any working status may become any other. Whether identity is still being checked, the answer is being
  // prepared, or the clock is paused for information from the data subject is the case worker's judgement;
  // there is no legal order between them to enforce, and a stalled request must not become unrecordable.
  ...WORKING.flatMap((from) => WORKING.filter((to) => to !== from).map((to) => t(from, to))),
  // Closing is an approver's decision, always with the outcome in words. A completed request must point at
  // the copy that was delivered and a refusal at the notice that was sent; a withdrawal is proved by the
  // data subject's own message, which the communication log already holds.
  ...WORKING.flatMap((from) =>
    (['COMPLETED', 'REFUSED'] as const).map((to) => t(from, to, 'approve', true, true)),
  ),
  ...WORKING.map((from) => t(from, 'WITHDRAWN', 'approve', true, false)),
];

export function findDsarTransition(from: DsarStatus, to: DsarStatus): DsarTransition | undefined {
  return DSAR_TRANSITIONS.find((transition) => transition.from === from && transition.to === to);
}

/** The moves available from one status, so a list never offers a forbidden one. */
export const nextDsarStatuses = (from: DsarStatus): DsarTransition[] =>
  DSAR_TRANSITIONS.filter((transition) => transition.from === from);

/**
 * Why a closure is refused even though the status move itself is allowed. Handing over data to somebody
 * whose identity was never proven is the failure this record exists to prevent, so `COMPLETED` requires a
 * verified identity. `REFUSED` is allowed on any identity state — refusing because verification failed is
 * a lawful outcome and has to be recordable — and `WITHDRAWN` is the data subject's own decision.
 */
export type DsarClosureBlock = 'identity_unverified';

export function dsarClosureBlock(
  to: DsarStatus,
  identityState: DsarIdentityState,
): DsarClosureBlock | null {
  if (to === 'COMPLETED' && identityState !== 'VERIFIED') return 'identity_unverified';
  return null;
}

/* ---------------------------------------------------------------------------------------------
 * The SLA measurement (`dsar.sla`, docs/metrics/README.md; AC-DSAR-02).
 * --------------------------------------------------------------------------------------------- */

/**
 * The four buckets the definition names, plus `notMeasured`. `openNotYetDue` is reported separately and is
 * excluded from the percentage — a request that is not late yet is neither a success nor a failure.
 */
export const SLA_BUCKETS = [
  'withinSla',
  'completedLate',
  'openPastDeadline',
  'openNotYetDue',
  'notMeasured',
] as const;
export type SlaBucket = (typeof SLA_BUCKETS)[number];

/** `breached`: completed after the deadline, or still open once it passed. */
export const BREACHED_SLA_BUCKETS: readonly SlaBucket[] = ['completedLate', 'openPastDeadline'];

/**
 * Which bucket one request falls in, against the organisation's calendar day. A refusal and a withdrawal
 * are `notMeasured`: the definition counts a request as answered when it was **completed**, and adding a
 * refusal to either side of the fraction would be inventing a rule the definition does not state. It is
 * reported in its own bucket instead, so nothing is dropped on the floor.
 */
export function slaBucketOf(
  request: { status: DsarStatus; dueOn: string | null; completedOn: string | null },
  today: string,
): SlaBucket {
  if (request.dueOn === null) return 'notMeasured';
  if (request.status === 'COMPLETED') {
    // the date is the record's own; a completion without one cannot exist (the database CHECK pairs them)
    return (request.completedOn ?? request.dueOn) <= request.dueOn ? 'withinSla' : 'completedLate';
  }
  if (isTerminalDsarStatus(request.status)) return 'notMeasured';
  return request.dueOn < today ? 'openPastDeadline' : 'openNotYetDue';
}

/** One decimal of a percent, or null when the denominator is empty (`no_records`, never a divide by zero). */
export function slaPercentage(withinSla: number, breached: number): number | null {
  const denominator = withinSla + breached;
  if (denominator === 0) return null;
  return Math.round((withinSla / denominator) * 1000) / 10;
}
