import type { RiskLevel } from '../scoring/methodologies.js';

/**
 * Remediation tasks: priorities, due dates and the status lifecycle (skill grc-domain, section 6).
 * Pure: the caller injects "today" (a calendar date in the organisation's time zone).
 */
export const TASK_PRIORITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

/** A task's priority follows the risk level of the finding it fixes. */
export const priorityForRisk = (level: RiskLevel): TaskPriority => level;

/** Reference defaults: days from creation to the due date, by priority (an organisation can change them). */
export const DEFAULT_DUE_DAYS: Readonly<Record<TaskPriority, number>> = {
  CRITICAL: 14,
  HIGH: 30,
  MEDIUM: 60,
  LOW: 90,
};

export const TASK_STATUSES = [
  'OPEN',
  'IN_PROGRESS',
  'BLOCKED',
  'COMPLETED',
  'VERIFIED',
  'CANCELLED',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Statuses of work that is still going on (a finding with such a task does not get a second one). */
export const ACTIVE_STATUSES: readonly TaskStatus[] = [
  'OPEN',
  'IN_PROGRESS',
  'BLOCKED',
  'COMPLETED',
];

export interface Transition {
  from: TaskStatus;
  to: TaskStatus;
  /** Who may do it: the assignee or an editor (`work`), or only an approver (`approve`). */
  by: 'work' | 'approve';
  /** A written reason is mandatory (reopening). */
  needsReason: boolean;
}

const t = (
  from: TaskStatus,
  to: TaskStatus,
  by: Transition['by'] = 'work',
  needsReason = false,
): Transition => ({ from, to, by, needsReason });

export const TRANSITIONS: readonly Transition[] = [
  t('OPEN', 'IN_PROGRESS'),
  t('OPEN', 'BLOCKED'),
  t('OPEN', 'CANCELLED'),
  t('IN_PROGRESS', 'OPEN'),
  t('IN_PROGRESS', 'BLOCKED'),
  t('IN_PROGRESS', 'COMPLETED'),
  t('IN_PROGRESS', 'CANCELLED'),
  t('BLOCKED', 'IN_PROGRESS'),
  t('BLOCKED', 'CANCELLED'),
  // verification is an approver's decision, separate from the person who did the work
  t('COMPLETED', 'VERIFIED', 'approve'),
  // reopening: back to work with a reason
  t('COMPLETED', 'IN_PROGRESS', 'approve', true),
  t('VERIFIED', 'IN_PROGRESS', 'approve', true),
  t('CANCELLED', 'OPEN', 'approve', true),
];

export function findTransition(from: TaskStatus, to: TaskStatus): Transition | undefined {
  return TRANSITIONS.find((transition) => transition.from === from && transition.to === to);
}

/** Statuses a task in `from` may move to (for showing only the valid actions). */
export const nextStatuses = (from: TaskStatus): Transition[] =>
  TRANSITIONS.filter((transition) => transition.from === from);

/** Today's calendar date (`YYYY-MM-DD`) in an IANA time zone. */
export function todayIn(timeZone: string, now: Date): string {
  // en-CA formats as YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** A calendar date plus whole days, as `YYYY-MM-DD` (pure date arithmetic, no zone involved). */
export function addDays(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const result = new Date(Date.UTC(year, month - 1, day + days));
  return result.toISOString().slice(0, 10);
}

/** The due date for a new task: today (organisation time zone) plus the days for its priority. */
export function dueDateFor(
  priority: TaskPriority,
  today: string,
  dueDays: Readonly<Record<TaskPriority, number>> = DEFAULT_DUE_DAYS,
): string {
  return addDays(today, dueDays[priority]);
}
