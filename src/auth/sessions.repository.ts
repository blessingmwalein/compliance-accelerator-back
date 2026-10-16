import { Injectable } from '@nestjs/common';
import type { Tx } from '../database/db-client.js';
import { PrismaService } from '../prisma/prisma.service.js';

export type RevokeReason = 'LOGOUT' | 'REFRESH_REUSE' | 'PASSWORD_RESET' | 'EXPIRED';

export interface RefreshTokenLookup {
  id: string;
  usedAt: Date | null;
  expiresAt: Date;
  session: { id: string; userId: string; expiresAt: Date; revokedAt: Date | null };
  userIsActive: boolean;
}

/** Sessions (one per login) and their rotating refresh tokens. Global tables: they belong to a user. */
@Injectable()
export class SessionsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(
    client: Tx,
    data: { userId: string; expiresAt: Date; userAgent: string | null; ipHash: string | null },
  ): Promise<{ id: string }> {
    return client.session.create({ data, select: { id: true } });
  }

  async createRefreshToken(
    client: Tx,
    data: { sessionId: string; tokenHash: string; expiresAt: Date },
  ): Promise<void> {
    await client.refreshToken.create({ data, select: { id: true } });
  }

  async findRefreshToken(
    tokenHash: string,
    client: Tx = this.prisma.db,
  ): Promise<RefreshTokenLookup | null> {
    const row = await client.refreshToken.findUnique({
      where: { tokenHash },
      select: {
        id: true,
        usedAt: true,
        expiresAt: true,
        session: {
          select: {
            id: true,
            userId: true,
            expiresAt: true,
            revokedAt: true,
            user: { select: { isActive: true } },
          },
        },
      },
    });
    if (!row) return null;
    const { user, ...session } = row.session;
    return {
      id: row.id,
      usedAt: row.usedAt,
      expiresAt: row.expiresAt,
      session,
      userIsActive: user.isActive,
    };
  }

  /**
   * Marks a refresh token used. Returns false when it was already used: the conditional update makes
   * rotation atomic, so two concurrent refreshes cannot both win.
   */
  async markRefreshTokenUsed(client: Tx, id: string, now: Date): Promise<boolean> {
    const result = await client.refreshToken.updateMany({
      where: { id, usedAt: null },
      data: { usedAt: now },
    });
    return result.count === 1;
  }

  async touch(client: Tx, sessionId: string, now: Date): Promise<void> {
    await client.session.update({ where: { id: sessionId }, data: { lastUsedAt: now } });
  }

  async revoke(client: Tx, sessionId: string, reason: RevokeReason, now: Date): Promise<void> {
    await client.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: now, revokedReason: reason },
    });
  }

  async revokeAllForUser(
    client: Tx,
    userId: string,
    reason: RevokeReason,
    now: Date,
  ): Promise<number> {
    const result = await client.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: now, revokedReason: reason },
    });
    return result.count;
  }

  /** The guard's per-request check: the session is live and belongs to the user in the token, and the user is active. */
  async isActive(sessionId: string, userId: string, now: Date): Promise<boolean> {
    const count = await this.prisma.db.session.count({
      where: {
        id: sessionId,
        userId,
        revokedAt: null,
        expiresAt: { gt: now },
        user: { isActive: true },
      },
    });
    return count === 1;
  }
}
