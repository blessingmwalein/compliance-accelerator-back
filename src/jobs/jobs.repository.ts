import { Injectable } from '@nestjs/common';
import type { Tx } from '../database/db-client.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

export interface NewJob {
  type: string;
  /** Ids only: never personal data or secrets. */
  payload: Record<string, unknown>;
  runAt?: Date;
  /** Deterministic; a second enqueue with the same key is ignored. */
  dedupeKey: string;
  maxAttempts?: number;
}

export interface ClaimedJob {
  id: string;
  type: string;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
}

interface ClaimedRow {
  id: string;
  type: string;
  payload: unknown;
  attempts: number;
  max_attempts: number;
}

/** The outbox table and its lease protocol (ADR-0006). All statements are short: safe behind the Neon pooler. */
@Injectable()
export class JobsRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Enqueues unless the dedupe key already exists (ON CONFLICT DO NOTHING). Returns whether a row was added. */
  async enqueue(job: NewJob, client: Tx = this.prisma.db): Promise<boolean> {
    const result = await client.job.createMany({
      data: [
        {
          type: job.type,
          payload: job.payload as Prisma.InputJsonValue,
          dedupeKey: job.dedupeKey,
          ...(job.runAt ? { runAt: job.runAt } : {}),
          ...(job.maxAttempts ? { maxAttempts: job.maxAttempts } : {}),
        },
      ],
      skipDuplicates: true,
    });
    return result.count === 1;
  }

  /**
   * A job whose lease expired on its LAST allowed attempt can never run again: dead-letter it so a
   * crashing handler cannot loop forever. Returns how many were dead-lettered.
   */
  async deadLetterExhaustedLeases(): Promise<number> {
    return this.prisma.db.$executeRaw`
      UPDATE jobs
      SET status = 'DEAD', lease_until = NULL, finished_at = now(), updated_at = now(),
          last_error = 'lease expired after the last allowed attempt'
      WHERE status = 'LEASED' AND lease_until < now() AND attempts >= max_attempts`;
  }

  /**
   * Claims up to `limit` runnable jobs (due and queued, or leased with an expired lease) for
   * `workerId`, using FOR UPDATE SKIP LOCKED so several workers never take the same row.
   */
  async claim(limit: number, leaseSeconds: number, workerId: string): Promise<ClaimedJob[]> {
    const rows = await this.prisma.db.$queryRaw<ClaimedRow[]>`
      UPDATE jobs
      SET status = 'LEASED', attempts = attempts + 1, leased_by = ${workerId},
          lease_until = now() + make_interval(secs => ${leaseSeconds}::double precision),
          updated_at = now()
      WHERE id IN (
        SELECT id FROM jobs
        WHERE (status = 'QUEUED' AND run_at <= now())
           OR (status = 'LEASED' AND lease_until < now() AND attempts < max_attempts)
        ORDER BY run_at
        LIMIT ${limit}::int
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, type, payload, attempts, max_attempts`;
    return rows.map((row) => ({
      id: row.id,
      type: row.type,
      payload: row.payload,
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
    }));
  }

  /** Only the worker that holds the lease can finish a job (a lost lease must not overwrite a newer attempt). */
  async succeed(id: string, workerId: string): Promise<boolean> {
    const result = await this.prisma.db.job.updateMany({
      where: { id, status: 'LEASED', leasedBy: workerId },
      data: { status: 'SUCCEEDED', finishedAt: new Date(), leaseUntil: null, lastError: null },
    });
    return result.count === 1;
  }

  /** Back to the queue for a retry at `retryAt`, or to the dead letters when `retryAt` is null. */
  async fail(id: string, workerId: string, error: string, retryAt: Date | null): Promise<boolean> {
    const result = await this.prisma.db.job.updateMany({
      where: { id, status: 'LEASED', leasedBy: workerId },
      data:
        retryAt === null
          ? { status: 'DEAD', finishedAt: new Date(), leaseUntil: null, lastError: error }
          : {
              status: 'QUEUED',
              runAt: retryAt,
              leaseUntil: null,
              leasedBy: null,
              lastError: error,
            },
    });
    return result.count === 1;
  }
}
