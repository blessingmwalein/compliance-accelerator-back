/**
 * The alert vocabulary (AC-BRC-02, AC-REMD-01). One alert is one `alert_deliveries` row plus one outbox job,
 * and the pair is idempotent: the dedupe key names the record, the threshold and the date the alert was
 * about, so a retried job lands on the same row and a re-run cannot send a second copy of a deadline that
 * nobody moved.
 *
 * An alert body carries a link and nothing else: no requester name, no breach description, no subject
 * count. The record is read in the application, behind its access rules.
 */
export const ALERT_KINDS = [
  'DSAR_DUE_SOON',
  'DSAR_OVERDUE',
  'BREACH_RECORDED',
  'BREACH_ASSESSMENT_DUE',
  'BREACH_NOTIFICATION_DUE',
  'REMINDER_DUE_SOON',
  'REMINDER_OVERDUE',
] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

export const ALERT_STATUSES = ['QUEUED', 'SENT', 'FAILED', 'SKIPPED'] as const;
export type AlertStatus = (typeof ALERT_STATUSES)[number];

/**
 * Why an alert did not go out. Each is a fact about the record re-read at send time, and it stays visible
 * on the row: a stale re-run is recorded as skipped, never silently dropped.
 */
export const ALERT_SKIP_REASONS = [
  'NO_RECIPIENT',
  'PREFERENCE_OFF',
  'STALE_DEADLINE',
  'ALREADY_HANDLED',
] as const;
export type AlertSkipReason = (typeof ALERT_SKIP_REASONS)[number];

/** The record column each kind names; the database CHECK and the repository both read this. */
export const ALERT_SOURCES = {
  DSAR_DUE_SOON: 'dsarRequest',
  DSAR_OVERDUE: 'dsarRequest',
  BREACH_RECORDED: 'breach',
  BREACH_ASSESSMENT_DUE: 'breach',
  BREACH_NOTIFICATION_DUE: 'breach',
  REMINDER_DUE_SOON: 'reminder',
  REMINDER_OVERDUE: 'reminder',
} as const satisfies Record<AlertKind, 'dsarRequest' | 'breach' | 'reminder'>;

/**
 * One alert per record, per threshold, per date. `dueOn` is the frozen deadline the alert was raised for,
 * so an extension that moved the date makes the old job provably stale instead of duplicating a send; a
 * record with no deadline (a breach as it is recorded) gets a stable non-dated key.
 */
export const alertDedupeKey = (kind: AlertKind, recordId: string, dueOn: string | null): string =>
  `${kind}:${recordId}:${dueOn ?? 'undated'}`;

/* ---------------------------------------------------------------------------------------------
 * Recipients (AC-BRC-02): the designated contact, falling back to the owners, valid even when the
 * recipient has no account at all.
 * --------------------------------------------------------------------------------------------- */

export interface AlertRecipient {
  address: string;
  /** A role, never a name: the row and the email say who was meant without recording who read it. */
  label: string;
}

export const DPO_RECIPIENT_LABEL = 'Data protection contact';
export const OWNER_RECIPIENT_LABEL = 'Company Owner';
/** A reminder is addressed to a person, but the row and the message name the ROLE, never the person. */
export const ASSIGNEE_RECIPIENT_LABEL = 'Reminder assignee';

/**
 * Who an incident alert goes to: the organisation's designated contact, or its Company Owners when there is
 * none. `ownerEmails` must arrive in a stable order — the caller reads the memberships ordered by id — so a
 * retried job that chooses again gets the same person rather than a different one.
 */
export function alertRecipientOf(
  dpoEmail: string | null,
  ownerEmails: readonly string[],
): AlertRecipient | null {
  const designated = dpoEmail?.trim() ?? '';
  if (designated !== '') return { address: designated.toLowerCase(), label: DPO_RECIPIENT_LABEL };
  const [first] = ownerEmails
    .filter((email) => email.trim() !== '')
    .map((email) => email.toLowerCase());
  return first === undefined ? null : { address: first, label: OWNER_RECIPIENT_LABEL };
}

/**
 * Only a reminder's own alerts respect a member's email choices. The alerts an incident raises to the
 * designated contact are not a preference, and no setting can silence them.
 */
export const isPreferenceGoverned = (kind: AlertKind): boolean =>
  kind === 'REMINDER_DUE_SOON' || kind === 'REMINDER_OVERDUE';

/** Which choice governs one reminder alert; null for every other kind. */
export const preferenceFieldFor = (kind: AlertKind): 'emailDueSoon' | 'emailOverdue' | null =>
  kind === 'REMINDER_DUE_SOON'
    ? 'emailDueSoon'
    : kind === 'REMINDER_OVERDUE'
      ? 'emailOverdue'
      : null;
