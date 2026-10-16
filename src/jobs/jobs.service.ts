import { Injectable } from '@nestjs/common';
import type { Tx } from '../database/db-client.js';
import { JobsRepository, type NewJob } from './jobs.repository.js';

/**
 * The producer side of the outbox. Pass the caller's `tx` so the job commits with the change that
 * causes it (a notification can never be sent for a rolled-back change, nor lost after a commit).
 * Payloads carry ids only. The dedupe key must be deterministic, for example
 * `dsar-overdue:{dsarId}:{dueDate}`: a retried request then enqueues nothing new.
 */
@Injectable()
export class JobsService {
  constructor(private readonly repository: JobsRepository) {}

  /** Returns true when a job was added, false when the dedupe key already existed. */
  enqueue(job: NewJob, tx?: Tx): Promise<boolean> {
    return this.repository.enqueue(job, tx);
  }
}
