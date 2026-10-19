import { addDays } from '../remediation/policy.js';
import { isTerminalDsarStatus, type DsarStatus } from './dsar.js';

/**
 * The deadline policy (AC-DSAR-03, AC-BRC-01, skill grc-domain section 7). One row per organisation, every
 * column nullable, and no reference default anywhere: a window that nobody chose is not a window, so an
 * unset column means `not_configured` on every record that would have used it.
 *
 * The numbers a record was created under are copied onto that record (`responseDays`, `assessmentDays`,
 * …) and the dates they produce are stored beside them, because a report has to show the SLA the request
 * was actually worked to rather than whatever the policy says today.
 */
export interface DeadlinePolicyRow {
  id: string;
  dsarResponseDays: number | null;
  dsarExtensionDays: number | null;
  dsarExtensionLimit: number | null;
  breachAssessmentDays: number | null;
  breachNotificationDays: number | null;
  alertLeadDays: number | null;
}

/** What a request freezes from the policy at creation, and the dates those numbers give. */
export interface DsarSchedule {
  /** The policy row in force, or null when there was none — and then there is no deadline either. */
  policyId: string | null;
  responseDays: number | null;
  /** `receivedOn + responseDays`, before any extension. Kept so the arithmetic of `dueOn` stays checkable. */
  baseDueOn: string | null;
  /** `baseDueOn` plus the extension days already granted (zero at creation). */
  dueOn: string | null;
}

export function dsarScheduleOf(
  policy: Pick<DeadlinePolicyRow, 'id' | 'dsarResponseDays'> | null,
  receivedOn: string,
  extensionDays = 0,
): DsarSchedule {
  const responseDays = policy?.dsarResponseDays ?? null;
  const baseDueOn = responseDays === null ? null : addDays(receivedOn, responseDays);
  return {
    policyId: policy?.id ?? null,
    responseDays,
    baseDueOn,
    dueOn: baseDueOn === null ? null : addDays(baseDueOn, extensionDays),
  };
}

/** What a breach freezes from the policy at creation, and the two dates those numbers give. */
export interface BreachSchedule {
  policyId: string | null;
  assessmentDays: number | null;
  notificationDays: number | null;
  assessmentDueOn: string | null;
  notificationDueOn: string | null;
}

export function breachScheduleOf(
  policy: Pick<DeadlinePolicyRow, 'id' | 'breachAssessmentDays' | 'breachNotificationDays'> | null,
  detectedOn: string,
): BreachSchedule {
  const assessmentDays = policy?.breachAssessmentDays ?? null;
  const notificationDays = policy?.breachNotificationDays ?? null;
  return {
    policyId: policy?.id ?? null,
    assessmentDays,
    notificationDays,
    assessmentDueOn: assessmentDays === null ? null : addDays(detectedOn, assessmentDays),
    notificationDueOn: notificationDays === null ? null : addDays(detectedOn, notificationDays),
  };
}

/* ---------------------------------------------------------------------------------------------
 * Extensions (AC-DSAR-01): only where the policy allows, with a reason, and one row each in the ledger.
 * --------------------------------------------------------------------------------------------- */

export const EXTENSION_BLOCKS = [
  'terminal_status',
  'no_due_date',
  'no_extension_policy',
  'limit_reached',
] as const;
export type ExtensionBlock = (typeof EXTENSION_BLOCKS)[number];

/** The request as the extension rule reads it: its frozen due date and the ledger already against it. */
export interface ExtendableRequest {
  status: DsarStatus;
  dueOn: string | null;
  extensionCount: number;
}

export type ExtensionDecision =
  | {
      allowed: true;
      /** The date the rule extended FROM, so the caller's ledger row cannot name a different one. */
      previousDueOn: string;
      days: number;
      newDueOn: string;
    }
  | { allowed: false; block: ExtensionBlock };

/**
 * Whether one more extension is allowed, and the date it produces. `null` policy means no extension at all
 * — the column being unset is a choice the organisation made, not a gap for the software to fill. The
 * limit is compared against the count already on the request, which the ledger and the database trigger
 * keep in step, so the answer cannot drift from the record.
 */
export function extensionDecisionOf(
  request: ExtendableRequest,
  policy: Pick<DeadlinePolicyRow, 'dsarExtensionDays' | 'dsarExtensionLimit'> | null,
): ExtensionDecision {
  if (isTerminalDsarStatus(request.status)) return { allowed: false, block: 'terminal_status' };
  if (request.dueOn === null) return { allowed: false, block: 'no_due_date' };
  const days = policy?.dsarExtensionDays ?? null;
  const limit = policy?.dsarExtensionLimit ?? null;
  if (days === null || limit === null) return { allowed: false, block: 'no_extension_policy' };
  if (request.extensionCount >= limit) return { allowed: false, block: 'limit_reached' };
  return {
    allowed: true,
    previousDueOn: request.dueOn,
    days,
    newDueOn: addDays(request.dueOn, days),
  };
}

/** Why an extension is blocked, in the words the API returns. Each block is a different 422/409 decision. */
export const EXTENSION_BLOCK_REASONS: Readonly<Record<ExtensionBlock, string>> = {
  terminal_status: 'The request is closed; an extension cannot be granted afterwards.',
  no_due_date:
    'The request has no deadline, because it was received without a response window configured.',
  no_extension_policy: 'No extension window or limit is configured for this organisation.',
  limit_reached: 'The request has already used every extension the policy allows.',
};
