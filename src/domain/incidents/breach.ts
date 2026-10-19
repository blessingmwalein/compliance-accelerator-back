import { deadlineStateOf, type DeadlineState } from './deadline.js';

/**
 * The breach lifecycle (AC-BRC-01, skill grc-domain section 6). The vocabularies mirror the Prisma enums in
 * `prisma/schema.prisma`.
 *
 * Containment is NOT a status: a breach can be contained while it is still being investigated, and a step
 * that happens twice is recorded twice, so detection, containment, impact and remediation are entries in
 * the append-only chronology and the status only tracks the broad phase the record is in.
 */
export const BREACH_STATUSES = ['RECORDED', 'INVESTIGATING', 'REMEDIATING', 'CLOSED'] as const;
export type BreachStatus = (typeof BREACH_STATUSES)[number];

/** The phase a chronology entry documents. A step, not a state. */
export const BREACH_CHRONOLOGY_KINDS = [
  'DETECTION',
  'INVESTIGATION',
  'CONTAINMENT',
  'IMPACT',
  'REMEDIATION',
  'NOTE',
] as const;
export type BreachChronologyKind = (typeof BREACH_CHRONOLOGY_KINDS)[number];

/** The notification duty, maintained by the service from the newest recorded decision (never edited free-hand). */
export const BREACH_NOTIFICATION_STATES = [
  'UNDECIDED',
  'NOTIFICATION_REQUIRED',
  'NOT_REQUIRED',
] as const;
export type BreachNotificationState = (typeof BREACH_NOTIFICATION_STATES)[number];

export const BREACH_DECISION_KINDS = ['REQUIRED', 'NOT_REQUIRED'] as const;
export type BreachNotificationDecisionKind = (typeof BREACH_DECISION_KINDS)[number];

/** A decision says what the notification duty is; the pair is what the database trigger insists upon. */
export const notificationStateOfDecision = (
  decision: BreachNotificationDecisionKind,
): BreachNotificationState => (decision === 'REQUIRED' ? 'NOTIFICATION_REQUIRED' : 'NOT_REQUIRED');

/** The three statuses a breach is being worked in. `CLOSED` is not one of them. */
const WORKING: readonly BreachStatus[] = ['RECORDED', 'INVESTIGATING', 'REMEDIATING'];

export interface BreachTransition {
  from: BreachStatus;
  to: BreachStatus;
  /** `work`: whoever owns the case; `approve`: only an approver may close it. */
  by: 'work' | 'approve';
  /** A written outcome is mandatory (the database CHECK requires the pair). */
  needsReason: boolean;
}

const t = (
  from: BreachStatus,
  to: BreachStatus,
  by: BreachTransition['by'] = 'work',
  needsReason = false,
): BreachTransition => ({ from, to, by, needsReason });

export const BREACH_TRANSITIONS: readonly BreachTransition[] = [
  // the working phases move in both directions: what was contained can reopen, and investigation can
  // resume after a fix is found not to have solved the problem
  t('RECORDED', 'INVESTIGATING'),
  t('RECORDED', 'REMEDIATING'),
  t('INVESTIGATING', 'REMEDIATING'),
  t('REMEDIATING', 'INVESTIGATING'),
  // closing is an approver's decision, with the outcome in words and a notification decision on the record
  t('RECORDED', 'CLOSED', 'approve', true),
  t('INVESTIGATING', 'CLOSED', 'approve', true),
  t('REMEDIATING', 'CLOSED', 'approve', true),
];

export function findBreachTransition(
  from: BreachStatus,
  to: BreachStatus,
): BreachTransition | undefined {
  return BREACH_TRANSITIONS.find((transition) => transition.from === from && transition.to === to);
}

/** The moves available from one status, so a list never offers a forbidden one. */
export const nextBreachStatuses = (from: BreachStatus): BreachTransition[] =>
  BREACH_TRANSITIONS.filter((transition) => transition.from === from);

/**
 * Why a closure is refused although the status move itself is allowed. `no_decision` is the rule that
 * stops a breach from being quietly finished: an authority asking whether the organisation assessed a
 * notification duty gets an answer in the ledger, not a status. The database trigger enforces the same
 * pair, so a code path that forgets to ask still cannot write it.
 */
export type BreachClosureBlock = 'no_decision';

export function breachClosureBlock(
  to: BreachStatus,
  hasDecision: boolean,
): BreachClosureBlock | null {
  if (to === 'CLOSED' && !hasDecision) return 'no_decision';
  return null;
}

/**
 * The two deadlines a breach carries, as the state a row shows. A closed breach is settled: neither
 * deadline is `overdue` afterwards, because the record says the organisation was done with it and the
 * chronology and decisions explain why.
 */
export function breachDeadlineStates(
  breach: {
    status: BreachStatus;
    assessmentDueOn: string | null;
    notificationDueOn: string | null;
    notificationState: BreachNotificationState;
  },
  today: string,
  leadDays: number | null,
): { assessment: DeadlineState; notification: DeadlineState } {
  const assessment = deadlineStateOf(breach.assessmentDueOn, today, leadDays);
  // A notification deadline is met by a decision, not by a fix: once the newest decision is on the record
  // the duty is answered, so only an undecided one past its date is late.
  const notification =
    breach.notificationState !== 'UNDECIDED'
      ? breach.notificationDueOn === null
        ? 'not_configured'
        : 'ok'
      : deadlineStateOf(breach.notificationDueOn, today, leadDays);
  // a closed breach is settled in both directions — the record says the organisation was done with it, and
  // the chronology and the decision say why
  const settle = (state: DeadlineState): DeadlineState =>
    state === 'not_configured' || breach.status !== 'CLOSED' ? state : 'ok';
  return { assessment: settle(assessment), notification: settle(notification) };
}

/** Was the breach detected in the organisation's current calendar year? (`annualTotal` of `breaches.open`.) */
export const detectedInCalendarYear = (detectedOn: string, today: string): boolean =>
  detectedOn.slice(0, 4) === today.slice(0, 4);

/** The working statuses, for "not Closed" counts and for what an alert may still fire for. */
export const isWorkingBreachStatus = (status: BreachStatus): boolean => WORKING.includes(status);
