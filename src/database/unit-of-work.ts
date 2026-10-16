import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EnvironmentVariables } from '../config/env.schema.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RequestContext } from '../tenancy/request-context.js';
import type { Tx } from './db-client.js';

export interface UnitOfWorkOptions {
  /** How long to wait for a pooled connection (Neon may be waking up). */
  maxWaitMs?: number;
  /** How long the transaction may run. Keep transactions short: the Neon pooler is PgBouncer. */
  timeoutMs?: number;
}

/**
 * Runs services' multi-step work (a change plus its audit event) in ONE database transaction.
 * Row-level security (ADR-0004 layer 5) is ON for every tenant table: the unit of work first sets
 * `app.org_id` for the verified tenant with `set_config(..., true)`, which is transaction-local and
 * therefore safe behind a transaction-mode pooler. A tenant query that does NOT run inside a unit of work
 * sees no rows at all (the policy fails closed), so every service reads and writes tenant data through
 * `uow.run`.
 *
 * Services call `uow.run(tx => ...)` and pass `tx` to repositories and the audit service. Nothing
 * inside may swallow an error: a throw rolls back everything, including the audit event.
 */
@Injectable()
export class UnitOfWork {
  private readonly maxWaitMs: number;
  private readonly timeoutMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly requestContext: RequestContext,
    config: ConfigService<EnvironmentVariables, true>,
  ) {
    // Waiting for a connection is bounded by the same limit as opening one (a cold Neon compute or a
    // distant region can take seconds); the transaction itself has its own, separate, limit.
    this.maxWaitMs = config.get('DATABASE_CONNECT_TIMEOUT_MS', { infer: true });
    this.timeoutMs = config.get('DATABASE_TRANSACTION_TIMEOUT_MS', { infer: true });
  }

  run<T>(fn: (tx: Tx) => Promise<T>, options: UnitOfWorkOptions = {}): Promise<T> {
    const organisationId = this.requestContext.organisationId;
    return this.prisma.db.$transaction(
      async (tx) => {
        if (organisationId) {
          await tx.$queryRaw`SELECT set_config('app.org_id', ${organisationId}, true)`;
        }
        return fn(tx);
      },
      {
        maxWait: options.maxWaitMs ?? this.maxWaitMs,
        timeout: options.timeoutMs ?? this.timeoutMs,
      },
    );
  }
}
