import { Injectable } from '@nestjs/common';
import { JobHandler, type JobContext, type JobHandlerContract } from '../jobs/job-handler.js';
import { ConsolidatedDpoService } from './consolidated-dpo.service.js';
import { REPORT_JOB_TYPES, type ReportGeneratePayload } from './report-jobs.js';

function parse(payload: unknown): ReportGeneratePayload {
  const { organisationId, reportId } = (payload ?? {}) as Partial<ReportGeneratePayload>;
  if (typeof organisationId !== 'string' || organisationId.length === 0) {
    throw new Error('Malformed job payload: organisationId missing');
  }
  if (typeof reportId !== 'string' || reportId.length === 0) {
    throw new Error('Malformed job payload: reportId missing');
  }
  return { organisationId, reportId };
}

/**
 * The asynchronous half of report generation (Phase 9a). The record and its job were written in one
 * transaction, so the row this runs for always exists; everything else — the period, the parameters, the data
 * the registers hold — is read again here, because a job runs at least once and the document must show what is
 * true when it runs, not what was true when it was asked for.
 */
@Injectable()
@JobHandler(REPORT_JOB_TYPES.generate)
export class ReportGenerateHandler implements JobHandlerContract {
  constructor(private readonly consolidatedDpo: ConsolidatedDpoService) {}

  async handle(payload: unknown, context: JobContext): Promise<void> {
    const { reportId } = parse(payload);
    await this.consolidatedDpo.render(reportId, context);
  }
}
