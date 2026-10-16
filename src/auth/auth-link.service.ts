import { Injectable } from '@nestjs/common';
import { Clock } from '../common/clock.js';
import { UnitOfWork } from '../database/unit-of-work.js';
import { AuthSettings } from './auth-settings.js';
import { AuthTokensRepository, type AuthTokenPurposeValue } from './auth-tokens.repository.js';
import { generateOpaqueToken, sha256Hex } from './tokens.js';

/**
 * Creates the one-time links in emails. It is called by the email JOB at send time, so the raw token
 * exists only in memory and in the message: the database and the job payload never hold a usable
 * secret (only the SHA-256 is stored). A retried job simply creates a fresh token and replaces any
 * unused one, so only the newest link works.
 */
@Injectable()
export class AuthLinkService {
  constructor(
    private readonly tokens: AuthTokensRepository,
    private readonly uow: UnitOfWork,
    private readonly settings: AuthSettings,
    private readonly clock: Clock,
  ) {}

  async issue(
    userId: string,
    purpose: AuthTokenPurposeValue,
    ttlMs: number,
    path: string,
  ): Promise<string> {
    const raw = generateOpaqueToken();
    const now = this.clock.now();
    await this.uow.run(async (tx) => {
      await this.tokens.deleteUnconsumed(tx, userId, purpose);
      await this.tokens.create(tx, {
        userId,
        purpose,
        tokenHash: sha256Hex(raw),
        expiresAt: new Date(now.getTime() + ttlMs),
      });
    });
    // The token is in the URL FRAGMENT: browsers never send it to a server, and it stays out of access logs and Referer headers.
    return `${this.settings.appBaseUrl}${path}#token=${raw}`;
  }

  /** A plain link into the app (no token). */
  plain(path: string): string {
    return `${this.settings.appBaseUrl}${path}`;
  }
}
