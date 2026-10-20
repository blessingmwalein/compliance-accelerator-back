/**
 * The outbox job types this module owns (ADR-0006). The payload carries the tenant and the report row and
 * nothing else: a queued document is re-read from the database when it runs, because a job runs at least once
 * and the data it should show is whatever is true when it does.
 */
export const REPORT_JOB_TYPES = {
  generate: 'report.generate',
} as const;

export interface ReportGeneratePayload {
  /** Required by ADR-0006: the runner opens the tenant scope from it before the handler starts. */
  organisationId: string;
  reportId: string;
}
