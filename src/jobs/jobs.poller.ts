import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JobsRunner, NodeEnv, type EnvironmentVariables } from '../config/env.schema.js';
import { JobRunner } from './job-runner.service.js';

const MAX_BACKOFF_MS = 60_000;

/**
 * The in-process driver of the job runner (always-on hosts and local development). It never runs in
 * tests and only when JOBS_RUNNER=inproc. It does not overlap itself, and when the database is
 * unreachable (or Neon is waking up) it backs off instead of hammering and flooding the log.
 * Polling keeps a scale-to-zero database awake: hosts that scale to zero use the tick endpoint.
 */
@Injectable()
export class JobsPoller implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(JobsPoller.name);
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  private failures = 0;
  private readonly enabled: boolean;
  private readonly intervalMs: number;

  constructor(
    private readonly runner: JobRunner,
    config: ConfigService<EnvironmentVariables, true>,
  ) {
    this.enabled =
      config.get('JOBS_RUNNER', { infer: true }) === JobsRunner.Inproc &&
      config.get('NODE_ENV', { infer: true }) !== NodeEnv.Test &&
      Boolean(config.get('DATABASE_URL', { infer: true }));
    this.intervalMs = config.get('JOBS_POLL_INTERVAL_MS', { infer: true });
  }

  onApplicationBootstrap(): void {
    if (!this.enabled) return;
    this.logger.log(`in-process job poller started (every ${this.intervalMs} ms)`);
    this.schedule(this.intervalMs);
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.tick(), delayMs);
    this.timer.unref(); // never keep the process alive just to poll
  }

  private async tick(): Promise<void> {
    try {
      await this.runner.runBatch();
      if (this.failures > 0) this.logger.log('job poller recovered');
      this.failures = 0;
    } catch (error) {
      this.failures++;
      // Log the first failure of a streak and then every tenth: a down database must not flood the log.
      if (this.failures === 1 || this.failures % 10 === 0) {
        this.logger.warn(
          `job poller cannot reach the database (failure ${this.failures}): ${(error as Error).message}`,
        );
      }
    }
    const delay = Math.min(MAX_BACKOFF_MS, this.intervalMs * 2 ** Math.min(this.failures, 6));
    this.schedule(this.failures === 0 ? this.intervalMs : delay);
  }
}
