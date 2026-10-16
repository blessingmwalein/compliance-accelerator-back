import { Injectable } from '@nestjs/common';
import type { Tx } from '../database/db-client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { AttemptRecord } from './lockout.js';

/** Counters behind the login lockout (Postgres-backed so they survive restarts and several instances). */
@Injectable()
export class LoginAttemptsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async record(
    client: Tx,
    data: { accountHash: string; ipHash: string | null; succeeded: boolean },
  ): Promise<void> {
    await client.loginAttempt.create({ data, select: { id: true } });
  }

  /** Newest first, bounded: enough to evaluate a window without reading an unbounded history. */
  async recentForAccount(accountHash: string, since: Date, limit = 100): Promise<AttemptRecord[]> {
    return this.prisma.db.loginAttempt.findMany({
      where: { accountHash, attemptedAt: { gt: since } },
      orderBy: { attemptedAt: 'desc' },
      take: limit,
      select: { succeeded: true, attemptedAt: true },
    });
  }

  async recentForIp(ipHash: string, since: Date, limit = 200): Promise<AttemptRecord[]> {
    return this.prisma.db.loginAttempt.findMany({
      where: { ipHash, attemptedAt: { gt: since } },
      orderBy: { attemptedAt: 'desc' },
      take: limit,
      select: { succeeded: true, attemptedAt: true },
    });
  }

  /** Housekeeping for a scheduled job (retention); not called on the request path. */
  async deleteOlderThan(client: Tx, cutoff: Date): Promise<number> {
    const result = await client.loginAttempt.deleteMany({ where: { attemptedAt: { lt: cutoff } } });
    return result.count;
  }
}
