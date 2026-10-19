import { addDays } from '../remediation/policy.js';

/**
 * Review state for the registers (risk, RoPA, lawful basis, retention, classification). Pure: the caller
 * injects "today" — the organisation's calendar date, from `todayIn(timeZone, now)`.
 *
 * `nextReviewDate` is the only due date that counts, and it is always set by a human. `reviewIntervalDays`
 * is the cadence the organisation stated for the record: it is shown next to the record and is NEVER used
 * to invent a due date, because a date nobody approved is not a deadline (skill grc-domain, section 3).
 */

/** How early a review counts as "due soon" when the record does not say (the reference default). */
export const REVIEW_LEAD_DAYS = 30;

/**
 * `not_reviewed` = no due date on the record. That is a fact about the data, not a verdict: an absent
 * date is never "overdue" and never "on time".
 */
export const REVIEW_STATES = ['not_reviewed', 'overdue', 'due_soon', 'ok'] as const;
export type ReviewState = (typeof REVIEW_STATES)[number];

/** `overdue` and `due_soon` both mean somebody should look at it now; `ok` does not. */
export const NEEDS_ATTENTION_STATES: readonly ReviewState[] = ['overdue', 'due_soon'];

/** The state of one record against the organisation's calendar day. */
export function reviewStateOf(
  nextReviewDate: string | null,
  today: string,
  leadDays: number = REVIEW_LEAD_DAYS,
): ReviewState {
  if (nextReviewDate === null) return 'not_reviewed';
  if (nextReviewDate < today) return 'overdue';
  if (nextReviewDate <= addDays(today, leadDays)) return 'due_soon';
  return 'ok';
}

/** The whole review view of one record: what to show in a row, and in the monitor buckets. */
export interface ReviewView {
  state: ReviewState;
  nextReviewDate: string | null;
  lastReviewDate: string | null;
  /** Whole days until the due date (negative = past due). Null when there is no due date. */
  daysRemaining: number | null;
}

export function reviewViewOf(
  nextReviewDate: string | null,
  lastReviewDate: string | null,
  today: string,
  leadDays: number = REVIEW_LEAD_DAYS,
): ReviewView {
  const DAY_MS = 86_400_000;
  return {
    state: reviewStateOf(nextReviewDate, today, leadDays),
    nextReviewDate,
    lastReviewDate,
    daysRemaining:
      nextReviewDate === null
        ? null
        : Math.round(
            (Date.parse(`${nextReviewDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS,
          ),
  };
}

/** The calendar day of a `DATE` column value (`YYYY-MM-DD`), read in UTC: never shifted by the host zone. */
export const dayOf = (value: Date): string =>
  `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, '0')}-${String(
    value.getUTCDate(),
  ).padStart(2, '0')}`;

/** The same, for a `DATE` column that may be absent. */
export const toDateOnly = (value: Date | null): string | null =>
  value === null ? null : dayOf(value);

/** A calendar day as the instant Prisma writes into a `DATE` column (UTC midnight). */
export const utcDay = (date: string): Date => new Date(`${date}T00:00:00.000Z`);
