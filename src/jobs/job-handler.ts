import { SetMetadata } from '@nestjs/common';

export const JOB_HANDLER_METADATA = 'fca:job-handler';

export interface JobContext {
  jobId: string;
  /** 1 on the first run. Jobs run at least once: handlers must be idempotent and re-check state. */
  attempt: number;
  maxAttempts: number;
}

/** A handler for one job type. Throw to fail the attempt (it is retried with backoff, then dead-lettered). */
export interface JobHandlerContract {
  handle(payload: unknown, context: JobContext): Promise<void>;
}

/** Marks a provider as the handler of a job type; the registry finds it by scanning providers at startup. */
export const JobHandler = (type: string) => SetMetadata(JOB_HANDLER_METADATA, type);
