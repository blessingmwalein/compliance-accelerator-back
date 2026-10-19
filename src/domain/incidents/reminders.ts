import { deadlineViewOf, effectiveLeadDays, type DeadlineView } from './deadline.js';

/**
 * Reminders (AC-REMD-01, skill grc-domain section 7). A reminder is assigned, completed or cancelled and
 * never deleted — "who was told about what, and did they act on it" is part of the record. The due state
 * comes from the shared deadline vocabulary, so a reminder, a data subject request and a register review
 * cannot disagree about what `overdue` means.
 */
export const REMINDER_STATUSES = ['PENDING', 'DONE', 'CANCELLED'] as const;
export type ReminderStatus = (typeof REMINDER_STATUSES)[number];

/** What a reminder points at. Polymorphic, like a legal hold's scope. */
export const REMINDER_SOURCE_KINDS = [
  'DSAR_REQUEST',
  'BREACH',
  'EVIDENCE',
  'RISK',
  'REMEDIATION_TASK',
  'OTHER',
] as const;
export type ReminderSourceKind = (typeof REMINDER_SOURCE_KINDS)[number];

export interface ReminderTransition {
  from: ReminderStatus;
  to: ReminderStatus;
  /** A written reason is mandatory: cancelling a date somebody set has to say why. */
  needsReason: boolean;
}

export const REMINDER_TRANSITIONS: readonly ReminderTransition[] = [
  { from: 'PENDING', to: 'DONE', needsReason: false },
  { from: 'PENDING', to: 'CANCELLED', needsReason: true },
];

export function findReminderTransition(
  from: ReminderStatus,
  to: ReminderStatus,
): ReminderTransition | undefined {
  return REMINDER_TRANSITIONS.find(
    (transition) => transition.from === from && transition.to === to,
  );
}

/**
 * A completed or cancelled reminder is not late: it is history. Its date is still shown beside it, which
 * is why this returns the whole view rather than only a state.
 */
export function reminderDeadlineViewOf(
  reminder: { status: ReminderStatus; dueOn: string; leadDays: number | null },
  today: string,
  policyAlertLeadDays: number | null,
): DeadlineView {
  const view = deadlineViewOf(
    reminder.dueOn,
    today,
    effectiveLeadDays(reminder.leadDays, policyAlertLeadDays),
  );
  // a reminder always has a date, so the state can only ever be one of the three measured ones
  return reminder.status === 'PENDING' ? view : { ...view, state: 'ok' };
}

/**
 * The email choices of one member (AC-REMD-01). Opt-out only, and only for reminders addressed to them:
 * the alerts a breach or a data subject request raise to the designated contact are not a preference and
 * nothing here can silence them. Both default to on, so a member who never opened the settings page still
 * hears about their own overdue work.
 */
export const REMINDER_PREFERENCE_DEFAULTS = { emailDueSoon: true, emailOverdue: true } as const;
export type ReminderPreferenceField = keyof typeof REMINDER_PREFERENCE_DEFAULTS;
