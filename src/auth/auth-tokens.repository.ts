import { Injectable } from '@nestjs/common';
import type { Tx } from '../database/db-client.js';
import { PrismaService } from '../prisma/prisma.service.js';

export type AuthTokenPurposeValue = 'EMAIL_VERIFICATION' | 'PASSWORD_RESET';

/** Email-verification and password-reset tokens: only the SHA-256 of the token is stored. */
@Injectable()
export class AuthTokensRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(
    client: Tx,
    data: { userId: string; purpose: AuthTokenPurposeValue; tokenHash: string; expiresAt: Date },
  ): Promise<void> {
    await client.authToken.create({ data, select: { id: true } });
  }

  /** A new token replaces any unused one of the same purpose, so only the newest link works. */
  async deleteUnconsumed(
    client: Tx,
    userId: string,
    purpose: AuthTokenPurposeValue,
  ): Promise<void> {
    await client.authToken.deleteMany({ where: { userId, purpose, consumedAt: null } });
  }

  /** Looks at a usable token WITHOUT consuming it (so a rejected new password does not burn the link). */
  async peek(
    tokenHash: string,
    purpose: AuthTokenPurposeValue,
    now: Date,
  ): Promise<{ userId: string } | null> {
    return this.prisma.db.authToken.findFirst({
      where: { tokenHash, purpose, consumedAt: null, expiresAt: { gt: now } },
      select: { userId: true },
    });
  }

  /**
   * Consumes a token exactly once: the conditional update succeeds only for an unconsumed, unexpired
   * token of this purpose, so a replay (or a race between two requests) finds nothing.
   */
  async consume(
    client: Tx,
    tokenHash: string,
    purpose: AuthTokenPurposeValue,
    now: Date,
  ): Promise<{ userId: string } | null> {
    const result = await client.authToken.updateMany({
      where: { tokenHash, purpose, consumedAt: null, expiresAt: { gt: now } },
      data: { consumedAt: now },
    });
    if (result.count !== 1) return null;
    return client.authToken.findUnique({ where: { tokenHash }, select: { userId: true } });
  }
}
