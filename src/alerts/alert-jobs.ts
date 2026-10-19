import type { AlertKind } from '../domain/incidents/alerts.js';

/**
 * One outbox job type per threshold (ADR-0006). A feature module registers one handler per type it owns;
 * the payload carries the tenant and the delivery row and nothing else, and the handler re-reads every
 * fact it acts on at send time, because a job runs at least once.
 */
export const ALERT_JOB_TYPES = {
  DSAR_DUE_SOON: 'alert.dsar-due-soon',
  DSAR_OVERDUE: 'alert.dsar-overdue',
  BREACH_RECORDED: 'alert.breach-recorded',
  BREACH_ASSESSMENT_DUE: 'alert.breach-assessment-due',
  BREACH_NOTIFICATION_DUE: 'alert.breach-notification-due',
  REMINDER_DUE_SOON: 'alert.reminder-due-soon',
  REMINDER_OVERDUE: 'alert.reminder-overdue',
} as const satisfies Record<AlertKind, string>;

/** The sentence the email says, chosen from the kind. Never a word from the record itself (AC-BRC-02). */
export const ALERT_SUMMARIES: Readonly<Record<AlertKind, string>> = {
  DSAR_DUE_SOON: 'A data subject request is due soon',
  DSAR_OVERDUE: 'A data subject request is past its deadline',
  BREACH_RECORDED: 'A personal data breach was recorded',
  BREACH_ASSESSMENT_DUE: 'A breach assessment is due',
  BREACH_NOTIFICATION_DUE: 'A breach notification decision is due',
  REMINDER_DUE_SOON: 'A reminder is due soon',
  REMINDER_OVERDUE: 'A reminder is overdue',
};

/**
 * The page each alert opens, with the record as the page's `open` parameter. The link is the whole message:
 * what the alert concerns is only visible behind the application's access rules.
 */
export const ALERT_PAGES: Readonly<Record<AlertKind, string>> = {
  DSAR_DUE_SOON: '/dsar-tracker',
  DSAR_OVERDUE: '/dsar-tracker',
  BREACH_RECORDED: '/breach-registry',
  BREACH_ASSESSMENT_DUE: '/breach-registry',
  BREACH_NOTIFICATION_DUE: '/breach-registry',
  REMINDER_DUE_SOON: '/reminders',
  REMINDER_OVERDUE: '/reminders',
};

export interface AlertJobPayload {
  /** Required by ADR-0006: the runner opens the tenant scope from it before the handler starts. */
  organisationId: string;
  alertId: string;
}
