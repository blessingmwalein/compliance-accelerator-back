import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException, ErrorCode, type FieldError } from '../common/errors/app.exception.js';
import { Clock, timeBucket } from '../common/clock.js';
import type { Tx } from '../database/db-client.js';
import { UnitOfWork } from '../database/unit-of-work.js';
import { JobsService } from '../jobs/jobs.service.js';
import { SecurityEventsService } from '../security-events/security-events.service.js';
import { AccessTokenService } from './access-token.service.js';
import {
  ACCOUNT_EXISTS_DEDUPE_SECONDS,
  AUTH_JOB_TYPES,
  PASSWORD_RESET_DEDUPE_SECONDS,
  VERIFICATION_DEDUPE_SECONDS,
} from './auth-jobs.js';
import { AuthSettings } from './auth-settings.js';
import { AuthTokensRepository } from './auth-tokens.repository.js';
import { KeyedHasher } from './keyed-hasher.js';
import { DEFAULT_LOCKOUT_POLICY, evaluateLockout } from './lockout.js';
import { LoginAttemptsRepository } from './login-attempts.repository.js';
import { checkPassword, type PasswordProblem } from './password-policy.js';
import { PasswordService } from './password.service.js';
import { SessionsRepository } from './sessions.repository.js';
import { generateOpaqueToken, sha256Hex } from './tokens.js';
import { UsersRepository, type UserRecord } from './users.repository.js';

/** What the controller knows about the caller; used for lockout counters and the session list, never for decisions. */
export interface ClientInfo {
  ip: string | undefined;
  userAgent: string | undefined;
}

/** What `login` and `refresh` hand back: the access token for the body and the refresh token for the cookie. */
export interface IssuedSession {
  accessToken: string;
  expiresInSeconds: number;
  refreshToken: string;
  /** Lifetime of the refresh cookie (until the session's absolute expiry). */
  refreshMaxAgeMs: number;
}

const PASSWORD_MESSAGES: Readonly<Record<PasswordProblem, string>> = {
  tooShort: 'Use at least 12 characters.',
  tooLong: 'Use at most 128 characters.',
  tooCommon: 'This password is too common. Choose something less guessable.',
  tooSimple: 'This password is too simple (repeated or sequential characters).',
  containsEmail: 'The password must not contain your email address.',
};

function passwordError(problems: PasswordProblem[]): AppException {
  const errors: FieldError[] = problems.map((problem) => ({
    path: 'password',
    code: `password.${problem}`,
    message: PASSWORD_MESSAGES[problem],
  }));
  return new AppException(
    ErrorCode.ValidationFailed,
    HttpStatus.BAD_REQUEST,
    'Request validation failed.',
    errors,
  );
}

const unauthenticated = (detail: string) =>
  new AppException(ErrorCode.Unauthenticated, HttpStatus.UNAUTHORIZED, detail);

const isUniqueViolation = (error: unknown) => (error as { code?: string } | null)?.code === 'P2002';

/**
 * Registration, email verification, login with lockout, rotating refresh with reuse detection,
 * logout, and password reset (ADR-0003). Principles: responses that could reveal whether an address
 * is registered are identical for known and unknown addresses; secrets are never stored or logged
 * (refresh and one-time tokens only as SHA-256); every outcome that matters leaves a security event.
 * Emails are never sent from here: they are enqueued in the same transaction (outbox).
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersRepository,
    private readonly sessions: SessionsRepository,
    private readonly authTokens: AuthTokensRepository,
    private readonly attempts: LoginAttemptsRepository,
    private readonly passwords: PasswordService,
    private readonly accessTokens: AccessTokenService,
    private readonly hasher: KeyedHasher,
    private readonly jobs: JobsService,
    private readonly events: SecurityEventsService,
    private readonly uow: UnitOfWork,
    private readonly settings: AuthSettings,
    private readonly clock: Clock,
  ) {}

  // ---------------------------------------------------------------- registration and verification

  /** Always resolves the same way, whether or not the address is already registered. */
  async register(
    input: { email: string; password: string; fullName: string },
    client: ClientInfo,
  ): Promise<void> {
    const problems = checkPassword(input.password, input.email);
    if (problems.length > 0) throw passwordError(problems);

    // Hash in every branch so response time does not reveal whether the address exists.
    const passwordHash = await this.passwords.hash(input.password);
    const now = this.clock.now();
    const ipHash = this.ipHash(client);

    const existing = await this.users.findByEmail(input.email);
    if (existing) {
      await this.handleExistingRegistration(existing, now, ipHash);
      return;
    }

    try {
      await this.uow.run(async (tx) => {
        const user = await this.users.create(tx, {
          email: input.email,
          fullName: input.fullName,
          passwordHash,
        });
        await this.jobs.enqueue(
          {
            type: AUTH_JOB_TYPES.sendVerification,
            payload: { userId: user.id },
            dedupeKey: `verify:${user.id}:${timeBucket(now, VERIFICATION_DEDUPE_SECONDS)}`,
          },
          tx,
        );
        await this.events.record(
          { type: 'auth.registered', userId: user.id, ...(ipHash ? { ipHash } : {}) },
          tx,
        );
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // Two registrations of one address raced: the loser is handled like "already registered".
      const winner = await this.users.findByEmail(input.email);
      if (winner) await this.handleExistingRegistration(winner, now, ipHash);
    }
  }

  private async handleExistingRegistration(
    user: UserRecord,
    now: Date,
    ipHash: string | undefined,
  ): Promise<void> {
    await this.uow.run(async (tx) => {
      // Verified: tell the owner (an email), change nothing. Unverified: send a fresh verification link,
      // and do NOT overwrite the stored password (that would let a stranger replace it).
      const job = user.emailVerifiedAt
        ? {
            type: AUTH_JOB_TYPES.sendAccountExists,
            dedupeKey: `account-exists:${user.id}:${timeBucket(now, ACCOUNT_EXISTS_DEDUPE_SECONDS)}`,
          }
        : {
            type: AUTH_JOB_TYPES.sendVerification,
            dedupeKey: `verify:${user.id}:${timeBucket(now, VERIFICATION_DEDUPE_SECONDS)}`,
          };
      await this.jobs.enqueue({ ...job, payload: { userId: user.id } }, tx);
      await this.events.record(
        {
          type: 'auth.registration_ignored_existing',
          userId: user.id,
          ...(ipHash ? { ipHash } : {}),
        },
        tx,
      );
    });
  }

  /** Uniform: resolves whether or not the address is registered. */
  async resendVerification(email: string, client: ClientInfo): Promise<void> {
    const user = await this.users.findByEmail(email);
    if (!user || !user.isActive || user.emailVerifiedAt) return;
    const now = this.clock.now();
    const ipHash = this.ipHash(client);
    await this.uow.run(async (tx) => {
      await this.jobs.enqueue(
        {
          type: AUTH_JOB_TYPES.sendVerification,
          payload: { userId: user.id },
          dedupeKey: `verify:${user.id}:${timeBucket(now, VERIFICATION_DEDUPE_SECONDS)}`,
        },
        tx,
      );
      await this.events.record(
        { type: 'auth.verification_resent', userId: user.id, ...(ipHash ? { ipHash } : {}) },
        tx,
      );
    });
  }

  /** Consumes the one-time token (a POST from the SPA page, never a GET link handler). */
  async verifyEmail(token: string): Promise<void> {
    const now = this.clock.now();
    const userId = await this.uow.run(async (tx) => {
      const consumed = await this.authTokens.consume(
        tx,
        sha256Hex(token),
        'EMAIL_VERIFICATION',
        now,
      );
      if (!consumed) return null;
      await this.users.markEmailVerified(tx, consumed.userId, now);
      await this.events.record({ type: 'auth.email_verified', userId: consumed.userId }, tx);
      return consumed.userId;
    });
    if (!userId) throw invalidToken();
  }

  // ---------------------------------------------------------------- login, refresh, logout

  async login(
    input: { email: string; password: string },
    client: ClientInfo,
  ): Promise<IssuedSession> {
    const now = this.clock.now();
    const accountHash = this.hasher.hash('account', input.email);
    const ipHash = this.ipHash(client);

    const since = new Date(now.getTime() - DEFAULT_LOCKOUT_POLICY.windowSeconds * 1000);
    const [accountAttempts, ipAttempts] = await Promise.all([
      this.attempts.recentForAccount(accountHash, since),
      ipHash ? this.attempts.recentForIp(ipHash, since) : Promise.resolve([]),
    ]);
    const lock = evaluateLockout({ accountAttempts, ipAttempts, now });
    if (lock.locked) {
      await this.events.record({
        type: 'auth.login_locked',
        outcome: 'DENIED',
        subjectHash: accountHash,
        ...(ipHash ? { ipHash } : {}),
      });
      throw new AppException(
        ErrorCode.RateLimited,
        HttpStatus.TOO_MANY_REQUESTS,
        'Too many failed sign-in attempts. Try again later.',
        undefined,
        { 'Retry-After': String(lock.retryAfterSeconds) },
      );
    }

    const user = await this.users.findByEmail(input.email);
    const passwordOk =
      user?.passwordHash && user.isActive
        ? await this.passwords.verify(user.passwordHash, input.password)
        : false;
    if (!user?.passwordHash || !user.isActive) await this.passwords.verifyDummy(input.password);

    if (!user || !passwordOk) {
      await this.uow.run(async (tx) => {
        await this.attempts.record(tx, { accountHash, ipHash: ipHash ?? null, succeeded: false });
        await this.events.record(
          {
            type: 'auth.login_failed',
            outcome: 'DENIED',
            subjectHash: accountHash,
            ...(ipHash ? { ipHash } : {}),
          },
          tx,
        );
      });
      throw new AppException(
        ErrorCode.InvalidCredentials,
        HttpStatus.UNAUTHORIZED,
        'Email or password is incorrect.',
      );
    }

    if (!user.emailVerifiedAt) {
      // The password was right, so this is not a guessing attempt: it does not count towards lockout.
      await this.uow.run(async (tx) => {
        await this.attempts.record(tx, { accountHash, ipHash: ipHash ?? null, succeeded: true });
        await this.events.record(
          { type: 'auth.login_unverified', outcome: 'DENIED', userId: user.id },
          tx,
        );
      });
      throw new AppException(
        ErrorCode.EmailNotVerified,
        HttpStatus.FORBIDDEN,
        'Confirm your email address before signing in.',
      );
    }

    return this.uow.run(async (tx) => {
      const session = await this.sessions.create(tx, {
        userId: user.id,
        expiresAt: new Date(now.getTime() + this.settings.sessionTtlMs),
        userAgent: client.userAgent?.slice(0, 200) ?? null,
        ipHash: ipHash ?? null,
      });
      const issued = await this.issueTokens(
        tx,
        user.id,
        session.id,
        new Date(now.getTime() + this.settings.sessionTtlMs),
        now,
      );
      await this.users.touchLogin(tx, user.id, now);
      await this.attempts.record(tx, { accountHash, ipHash: ipHash ?? null, succeeded: true });
      await this.events.record(
        { type: 'auth.login_succeeded', userId: user.id, ...(ipHash ? { ipHash } : {}) },
        tx,
      );
      return issued;
    });
  }

  /**
   * Rotates the refresh token: the presented token is marked used and a new one is issued. A token
   * that was already used is presented again: within the grace window that is a concurrent request
   * (several tabs restoring at once) and gets a fresh pair; later it means the token leaked, and the
   * whole session (family) is revoked.
   */
  async refresh(rawToken: string | undefined, client: ClientInfo): Promise<IssuedSession> {
    if (!rawToken) throw unauthenticated('No refresh token.');
    const now = this.clock.now();
    const found = await this.sessions.findRefreshToken(sha256Hex(rawToken));
    if (!found) throw unauthenticated('Invalid refresh token.');

    const { session } = found;
    if (
      session.revokedAt ||
      session.expiresAt <= now ||
      found.expiresAt <= now ||
      !found.userIsActive
    ) {
      throw unauthenticated('Session expired.');
    }

    const graceMs = this.settings.refreshReuseGraceMs;
    if (found.usedAt && !(graceMs > 0 && now.getTime() - found.usedAt.getTime() < graceMs)) {
      await this.revokeFamilyForReuse(session.id, session.userId, now, client);
      throw unauthenticated('Session revoked.');
    }

    const issued = await this.uow.run(async (tx) => {
      if (!found.usedAt) {
        const won = await this.sessions.markRefreshTokenUsed(tx, found.id, now);
        // Lost a race to a concurrent refresh with the same token: only acceptable inside the grace window.
        if (!won && graceMs === 0) return null;
      }
      const tokens = await this.issueTokens(tx, session.userId, session.id, session.expiresAt, now);
      await this.sessions.touch(tx, session.id, now);
      return tokens;
    });
    if (!issued) {
      await this.revokeFamilyForReuse(session.id, session.userId, now, client);
      throw unauthenticated('Session revoked.');
    }
    return issued;
  }

  /** Ends the session of the presented refresh token. Always succeeds: logout is idempotent and uniform. */
  async logout(rawToken: string | undefined): Promise<void> {
    if (!rawToken) return;
    const found = await this.sessions.findRefreshToken(sha256Hex(rawToken));
    if (!found || found.session.revokedAt) return;
    const now = this.clock.now();
    await this.uow.run(async (tx) => {
      await this.sessions.revoke(tx, found.session.id, 'LOGOUT', now);
      await this.events.record({ type: 'auth.logout', userId: found.session.userId }, tx);
    });
  }

  // ---------------------------------------------------------------- password reset

  /** Uniform: resolves whether or not the address is registered. */
  async forgotPassword(email: string, client: ClientInfo): Promise<void> {
    const user = await this.users.findByEmail(email);
    const ipHash = this.ipHash(client);
    if (!user || !user.isActive) return;
    const now = this.clock.now();
    await this.uow.run(async (tx) => {
      await this.jobs.enqueue(
        {
          type: AUTH_JOB_TYPES.sendPasswordReset,
          payload: { userId: user.id },
          dedupeKey: `pwreset:${user.id}:${timeBucket(now, PASSWORD_RESET_DEDUPE_SECONDS)}`,
        },
        tx,
      );
      await this.events.record(
        { type: 'auth.password_reset_requested', userId: user.id, ...(ipHash ? { ipHash } : {}) },
        tx,
      );
    });
  }

  /**
   * Consumes the reset token (once), sets the new password, proves the address (the link went to it),
   * ends EVERY session of the user and queues a "your password changed" notice.
   */
  async resetPassword(input: { token: string; password: string }): Promise<void> {
    const now = this.clock.now();
    const tokenHash = sha256Hex(input.token);

    // Look first (without consuming) so a weak password does not burn the token, and the policy can see the email.
    const pending = await this.authTokens.peek(tokenHash, 'PASSWORD_RESET', now);
    if (!pending) throw invalidToken();
    const user = await this.users.findById(pending.userId);
    if (!user || !user.isActive) throw invalidToken();

    const problems = checkPassword(input.password, user.email);
    if (problems.length > 0) throw passwordError(problems);
    const passwordHash = await this.passwords.hash(input.password);

    const done = await this.uow.run(async (tx) => {
      const consumed = await this.authTokens.consume(tx, tokenHash, 'PASSWORD_RESET', now);
      if (!consumed || consumed.userId !== user.id) return false;
      await this.users.setPassword(tx, user.id, passwordHash, now);
      await this.authTokens.deleteUnconsumed(tx, user.id, 'PASSWORD_RESET');
      await this.sessions.revokeAllForUser(tx, user.id, 'PASSWORD_RESET', now);
      await this.jobs.enqueue(
        {
          type: AUTH_JOB_TYPES.sendPasswordChanged,
          payload: { userId: user.id },
          dedupeKey: `pwchanged:${user.id}:${tokenHash.slice(0, 16)}`,
        },
        tx,
      );
      await this.events.record({ type: 'auth.password_reset_completed', userId: user.id }, tx);
      return true;
    });
    if (!done) throw invalidToken();
  }

  // ---------------------------------------------------------------- helpers

  /** The signed-in user (the data behind GET /me). */
  async getUser(userId: string): Promise<UserRecord> {
    const user = await this.users.findById(userId);
    if (!user || !user.isActive) throw unauthenticated('Unknown user.');
    return user;
  }

  private async issueTokens(
    tx: Tx,
    userId: string,
    sessionId: string,
    sessionExpiresAt: Date,
    now: Date,
  ): Promise<IssuedSession> {
    const refreshToken = generateOpaqueToken();
    await this.sessions.createRefreshToken(tx, {
      sessionId,
      tokenHash: sha256Hex(refreshToken),
      expiresAt: sessionExpiresAt,
    });
    const accessToken = await this.accessTokens.sign({ sub: userId, sid: sessionId });
    return {
      accessToken,
      expiresInSeconds: this.settings.accessTtlSeconds,
      refreshToken,
      refreshMaxAgeMs: Math.max(0, sessionExpiresAt.getTime() - now.getTime()),
    };
  }

  private async revokeFamilyForReuse(
    sessionId: string,
    userId: string,
    now: Date,
    client: ClientInfo,
  ): Promise<void> {
    const ipHash = this.ipHash(client);
    await this.uow.run(async (tx) => {
      await this.sessions.revoke(tx, sessionId, 'REFRESH_REUSE', now);
      await this.events.record(
        {
          type: 'auth.refresh_reuse_detected',
          outcome: 'DENIED',
          userId,
          ...(ipHash ? { ipHash } : {}),
        },
        tx,
      );
    });
  }

  private ipHash(client: ClientInfo): string | undefined {
    return client.ip ? this.hasher.hash('ip', client.ip) : undefined;
  }
}

function invalidToken(): AppException {
  return new AppException(
    ErrorCode.InvalidToken,
    HttpStatus.BAD_REQUEST,
    'This link is invalid or has expired.',
  );
}
