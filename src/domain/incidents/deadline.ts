import { addDays } from '../remediation/policy.js';

/**
 * The deadline states of the Phase 7 records (a data subject request, a breach, a reminder, an evidence
 * review). Pure: the caller injects "today" — the organisation's calendar date, from `todayIn(timeZone, now)`.
 *
 * These are the same four comparisons `src/domain/registers/review.ts` makes, so a request and a
 * processing activity cannot disagree about what `overdue` means. The first state is renamed, because on
 * an incident the absent date is a policy nobody configured rather than a register nobody reviewed:
 * `not_configured` is what AC-DSAR-03 asks the API and the UI to report, and it is never "on time"
 * (skill grc-domain, section 7 — deadlines are data, not code, and there is no shipped fallback).
 */
export const DEADLINE_STATES = ['not_configured', 'overdue', 'due_soon', 'ok'] as const;
export type DeadlineState = (typeof DEADLINE_STATES)[number];

/** `overdue` and `due_soon` both mean somebody should act now; `ok` and `not_configured` do not. */
export const NEEDS_ATTENTION_DEADLINES: readonly DeadlineState[] = ['overdue', 'due_soon'];

/**
 * The state of one due date. `leadDays` is the organisation's early-warning window; `null` means it
 * configured none, so `due_soon` is never returned and only a passed date raises an alert.
 */
export function deadlineStateOf(
  dueOn: string | null,
  today: string,
  leadDays: number | null,
): DeadlineState {
  if (dueOn === null) return 'not_configured';
  if (dueOn < today) return 'overdue';
  if (leadDays !== null && dueOn <= addDays(today, leadDays)) return 'due_soon';
  return 'ok';
}

/** Whole days from the organisation's today to a calendar day (negative = past). Null when there is no day. */
export const daysBetween = (today: string, date: string | null): number | null =>
  date === null
    ? null
    : Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);

/** The state, the date it was measured against and the count beside it — one row of a list or a monitor. */
export interface DeadlineView {
  state: DeadlineState;
  dueOn: string | null;
  daysRemaining: number | null;
}

export function deadlineViewOf(
  dueOn: string | null,
  today: string,
  leadDays: number | null,
): DeadlineView {
  return {
    state: deadlineStateOf(dueOn, today, leadDays),
    dueOn,
    daysRemaining: daysBetween(today, dueOn),
  };
}

/**
 * The early-warning window a record is judged by: its own when it sets one, the policy's otherwise, none
 * if neither exists. A reminder has `leadDays` and a request does not, so the same rule reads differently
 * per record and never needs a constant.
 */
export const effectiveLeadDays = (
  recordLeadDays: number | null,
  policyAlertLeadDays: number | null,
): number | null => recordLeadDays ?? policyAlertLeadDays;

/** The offset of an IANA zone at an instant, in milliseconds (`+02:00` is 7 200 000). */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);
  const value = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');
  const asUtc = Date.UTC(
    value('year'),
    value('month') - 1,
    value('day'),
    value('hour') % 24,
    value('minute'),
    value('second'),
  );
  return asUtc - instant.getTime();
}

/**
 * The instant an alert fires: 08:00 on a calendar day in the organisation's zone, not 08:00 UTC. A job that
 * runs at UTC midnight reaches somebody in New York during the afternoon of the day BEFORE, which would say
 * a deadline has passed while it still has hours to run (skill grc-domain, section 7).
 */
export function alertInstantOn(day: string, timeZone: string): Date {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  const naive = Date.UTC(year, month - 1, date, 8);
  // the offset is read twice: at the naive guess and again at the instant that guess produced, so a DST
  // change between the two is measured where it actually applies
  const first = naive - zoneOffsetMs(new Date(naive), timeZone);
  const second = naive - zoneOffsetMs(new Date(first), timeZone);
  return new Date(second);
}
