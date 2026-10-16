import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import type { EnvironmentVariables } from '../config/env.schema.js';
import { RequestContext } from '../tenancy/request-context.js';
import { backoffSeconds, sanitiseError } from './backoff.js';
import { JobHandlerRegistry } from './job-handler.registry.js';
import { JobsRepository, type ClaimedJob } from './jobs.repository.js';

export interface RunSummary {
  claimed: number;
  succeeded: number;
  /** Failed but queued again with backoff. */
  retried: number;
  /** Dead-lettered: out of attempts, no handler, or an exhausted lease. */
  dead: number;
}

export interface RunOptions {
  limit?: number;
  leaseSeconds?: number;
  /** Identifies this runner on the lease; defaults to a fresh id per call. */
  workerId?: string;
}

/**
 * Claims and runs a bounded batch of due jobs (ADR-0006). The same code serves the in-process
 * poller and the HMAC-signed tick endpoint. One failing job never stops the batch. Jobs are
 * at-least-once, so handlers must be idempotent. Log lines carry job id, type, attempt, duration
 * and outcome, never the payload.
 */
@Injectable()
export class JobRunner {
  private readonly logger = new Logger(JobRunner.name);
  private readonly defaultLimit: number;
  private readonly defaultLeaseSeconds: number;

  constructor(
    private readonly repository: JobsRepository,
    private readonly registry: JobHandlerRegistry,
    private readonly requestContext: RequestContext,
    config: ConfigService<EnvironmentVariables, true>,
  ) {
    this.defaultLimit = config.get('JOBS_BATCH_SIZE', { infer: true });
    this.defaultLeaseSeconds = config.get('JOBS_LEASE_SECONDS', { infer: true });
  }

  async runBatch(options: RunOptions = {}): Promise<RunSummary> {
    const workerId = options.workerId ?? `runner-${randomUUID().slice(0, 8)}`;
    const summary: RunSummary = { claimed: 0, succeeded: 0, retried: 0, dead: 0 };

    summary.dead += await this.repository.deadLetterExhaustedLeases();
    const jobs = await this.repository.claim(
      options.limit ?? this.defaultLimit,
      options.leaseSeconds ?? this.defaultLeaseSeconds,
      workerId,
    );
    summary.claimed = jobs.length;

    for (const job of jobs) {
      const outcome = await this.runOne(job, workerId);
      if (outcome === 'succeeded') summary.succeeded++;
      else if (outcome === 'retried') summary.retried++;
      else if (outcome === 'dead') summary.dead++;
    }
    return summary;
  }

  private async runOne(
    job: ClaimedJob,
    workerId: string,
  ): Promise<'succeeded' | 'retried' | 'dead' | 'lost'> {
    const started = Date.now();
    const handler = this.registry.get(job.type);

    if (!handler) {
      await this.repository.fail(job.id, workerId, `no handler registered for "${job.type}"`, null);
      this.logger.error(
        `job ${job.id} type=${job.type} attempt=${job.attempts} outcome=dead (no handler)`,
      );
      return 'dead';
    }

    try {
      // Tenant jobs carry their organisation in the payload: run them inside that tenant scope so tenant
      // repositories work. There is no actor: the audit trail records the work as SYSTEM.
      const organisationId = organisationOf(job.payload);
      await this.requestContext.run(
        { requestIdOf: () => `job:${job.id}`, ...(organisationId ? { organisationId } : {}) },
        () =>
          handler.handle(job.payload, {
            jobId: job.id,
            attempt: job.attempts,
            maxAttempts: job.maxAttempts,
          }),
      );
      const owned = await this.repository.succeed(job.id, workerId);
      this.logger.log(
        `job ${job.id} type=${job.type} attempt=${job.attempts} outcome=succeeded durationMs=${Date.now() - started}`,
      );
      return owned ? 'succeeded' : 'lost';
    } catch (error) {
      const message = sanitiseError(error);
      const exhausted = job.attempts >= job.maxAttempts;
      const retryAt = exhausted ? null : new Date(Date.now() + backoffSeconds(job.attempts) * 1000);
      await this.repository.fail(job.id, workerId, message, retryAt);
      const outcome = exhausted ? 'dead' : 'retried';
      const line = `job ${job.id} type=${job.type} attempt=${job.attempts}/${job.maxAttempts} outcome=${outcome} durationMs=${Date.now() - started} error=${message}`;
      if (exhausted) this.logger.error(line);
      else this.logger.warn(line);
      return outcome;
    }
  }
}

function organisationOf(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const value = (payload as { organisationId?: unknown }).organisationId;
  return typeof value === 'string' ? value : undefined;
}
