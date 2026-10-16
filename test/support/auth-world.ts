import { randomUUID } from 'node:crypto';
import { JwtService } from '@nestjs/jwt';
import { AccessTokenService } from '../../src/auth/access-token.service.js';
import { AuthService } from '../../src/auth/auth.service.js';
import { KeyedHasher } from '../../src/auth/keyed-hasher.js';
import type { LockoutPolicy } from '../../src/auth/lockout.js';
import { PasswordService } from '../../src/auth/password.service.js';
import { sha256Hex } from '../../src/auth/tokens.js';
import type {
  AuthTokenPurposeValue,
  AuthTokensRepository,
} from '../../src/auth/auth-tokens.repository.js';
import type { LoginAttemptsRepository } from '../../src/auth/login-attempts.repository.js';
import type {
  RefreshTokenLookup,
  RevokeReason,
  SessionsRepository,
} from '../../src/auth/sessions.repository.js';
import type { UserRecord, UsersRepository } from '../../src/auth/users.repository.js';
import { Clock } from '../../src/common/clock.js';
import type { UnitOfWork } from '../../src/database/unit-of-work.js';
import type { JobsService } from '../../src/jobs/jobs.service.js';
import type { NewJob } from '../../src/jobs/jobs.repository.js';
import type {
  SecurityEventInput,
  SecurityEventsService,
} from '../../src/security-events/security-events.service.js';
import { makeSettings } from './auth-fixtures.js';

/** A clock the test moves by hand. */
export class TestClock extends Clock {
  constructor(public current = new Date('2026-10-15T12:00:00Z')) {
    super();
  }
  override now(): Date {
    return new Date(this.current);
  }
  advance(seconds: number): void {
    this.current = new Date(this.current.getTime() + seconds * 1000);
  }
}

interface SessionRow {
  id: string;
  userId: string;
  expiresAt: Date;
  revokedAt: Date | null;
  revokedReason: RevokeReason | null;
  touchedAt: Date | null;
}
interface RefreshRow {
  id: string;
  sessionId: string;
  tokenHash: string;
  expiresAt: Date;
  usedAt: Date | null;
}
interface AuthTokenRow {
  userId: string;
  purpose: AuthTokenPurposeValue;
  tokenHash: string;
  expiresAt: Date;
  consumedAt: Date | null;
}
interface AttemptRow {
  accountHash: string;
  ipHash: string | null;
  succeeded: boolean;
  attemptedAt: Date;
}

/**
 * An in-memory stand-in for the database-backed repositories, with the same observable contract
 * (conditional updates return whether they won, tokens are looked up by hash). Business rules are
 * exercised for real: only persistence is faked. Database behaviour (constraints, rollback, SQL) is
 * proven by the integration specs.
 */
export function createAuthWorld(
  options: { refreshGraceSeconds?: number; lockout?: Partial<LockoutPolicy> } = {},
) {
  const clock = new TestClock();
  const settings = makeSettings({ REFRESH_REUSE_GRACE_SECONDS: options.refreshGraceSeconds ?? 10 });

  const users: Array<UserRecord & { lastLoginAt?: Date }> = [];
  const sessions = new Map<string, SessionRow>();
  const refreshTokens = new Map<string, RefreshRow>(); // by tokenHash
  const authTokens: AuthTokenRow[] = [];
  const attempts: AttemptRow[] = [];
  const jobs: NewJob[] = [];
  const events: SecurityEventInput[] = [];
  const jobKeys = new Set<string>();

  const usersRepo = {
    findByEmail: async (email: string) => users.find((u) => u.email === email) ?? null,
    findById: async (id: string) => users.find((u) => u.id === id) ?? null,
    create: async (
      _tx: unknown,
      data: { email: string; fullName: string; passwordHash: string },
    ) => {
      if (users.some((u) => u.email === data.email))
        throw Object.assign(new Error('unique'), { code: 'P2002' });
      const user: UserRecord = {
        id: randomUUID(),
        ...data,
        isActive: true,
        emailVerifiedAt: null,
        isPlatformAdmin: false,
        createdAt: clock.now(),
      };
      users.push(user);
      return user;
    },
    markEmailVerified: async (_tx: unknown, userId: string, now: Date) => {
      const user = users.find((u) => u.id === userId);
      if (user && !user.emailVerifiedAt) user.emailVerifiedAt = now;
    },
    setPassword: async (_tx: unknown, userId: string, passwordHash: string, now: Date) => {
      const user = users.find((u) => u.id === userId)!;
      user.passwordHash = passwordHash;
      user.emailVerifiedAt ??= now;
    },
    touchLogin: async (_tx: unknown, userId: string, now: Date) => {
      users.find((u) => u.id === userId)!.lastLoginAt = now;
    },
  };

  const sessionsRepo = {
    create: async (_tx: unknown, data: { userId: string; expiresAt: Date }) => {
      const row: SessionRow = {
        id: randomUUID(),
        userId: data.userId,
        expiresAt: data.expiresAt,
        revokedAt: null,
        revokedReason: null,
        touchedAt: null,
      };
      sessions.set(row.id, row);
      return { id: row.id };
    },
    createRefreshToken: async (
      _tx: unknown,
      data: { sessionId: string; tokenHash: string; expiresAt: Date },
    ) => {
      refreshTokens.set(data.tokenHash, { id: randomUUID(), usedAt: null, ...data });
    },
    findRefreshToken: async (tokenHash: string): Promise<RefreshTokenLookup | null> => {
      const row = refreshTokens.get(tokenHash);
      if (!row) return null;
      const session = sessions.get(row.sessionId)!;
      const user = users.find((u) => u.id === session.userId)!;
      return {
        id: row.id,
        usedAt: row.usedAt,
        expiresAt: row.expiresAt,
        session: {
          id: session.id,
          userId: session.userId,
          expiresAt: session.expiresAt,
          revokedAt: session.revokedAt,
        },
        userIsActive: user.isActive,
      };
    },
    markRefreshTokenUsed: async (_tx: unknown, id: string, now: Date) => {
      const row = [...refreshTokens.values()].find((r) => r.id === id)!;
      if (row.usedAt) return false;
      row.usedAt = now;
      return true;
    },
    touch: async (_tx: unknown, sessionId: string, now: Date) => {
      sessions.get(sessionId)!.touchedAt = now;
    },
    revoke: async (_tx: unknown, sessionId: string, reason: RevokeReason, now: Date) => {
      const session = sessions.get(sessionId)!;
      if (!session.revokedAt) Object.assign(session, { revokedAt: now, revokedReason: reason });
    },
    revokeAllForUser: async (_tx: unknown, userId: string, reason: RevokeReason, now: Date) => {
      let count = 0;
      for (const session of sessions.values()) {
        if (session.userId === userId && !session.revokedAt) {
          Object.assign(session, { revokedAt: now, revokedReason: reason });
          count++;
        }
      }
      return count;
    },
    isActive: async (sessionId: string, userId: string, now: Date) => {
      const s = sessions.get(sessionId);
      const u = users.find((x) => x.id === userId);
      return Boolean(s && u?.isActive && s.userId === userId && !s.revokedAt && s.expiresAt > now);
    },
  };

  const authTokensRepo = {
    create: async (_tx: unknown, data: Omit<AuthTokenRow, 'consumedAt'>) =>
      void authTokens.push({ ...data, consumedAt: null }),
    deleteUnconsumed: async (_tx: unknown, userId: string, purpose: AuthTokenPurposeValue) => {
      for (let i = authTokens.length - 1; i >= 0; i--) {
        if (
          authTokens[i]!.userId === userId &&
          authTokens[i]!.purpose === purpose &&
          !authTokens[i]!.consumedAt
        )
          authTokens.splice(i, 1);
      }
    },
    peek: async (tokenHash: string, purpose: AuthTokenPurposeValue, now: Date) => {
      const row = authTokens.find(
        (t) =>
          t.tokenHash === tokenHash && t.purpose === purpose && !t.consumedAt && t.expiresAt > now,
      );
      return row ? { userId: row.userId } : null;
    },
    consume: async (_tx: unknown, tokenHash: string, purpose: AuthTokenPurposeValue, now: Date) => {
      const row = authTokens.find(
        (t) =>
          t.tokenHash === tokenHash && t.purpose === purpose && !t.consumedAt && t.expiresAt > now,
      );
      if (!row) return null;
      row.consumedAt = now;
      return { userId: row.userId };
    },
  };

  const attemptsRepo = {
    record: async (_tx: unknown, data: Omit<AttemptRow, 'attemptedAt'>) =>
      void attempts.push({ ...data, attemptedAt: clock.now() }),
    recentForAccount: async (accountHash: string, since: Date) =>
      attempts.filter((a) => a.accountHash === accountHash && a.attemptedAt > since),
    recentForIp: async (ipHash: string, since: Date) =>
      attempts.filter((a) => a.ipHash === ipHash && a.attemptedAt > since),
  };

  const jobsService = {
    enqueue: async (job: NewJob) => {
      if (jobKeys.has(job.dedupeKey)) return false;
      jobKeys.add(job.dedupeKey);
      jobs.push(job);
      return true;
    },
  };
  const eventsService = { record: async (event: SecurityEventInput) => void events.push(event) };
  const uow = { run: <T>(fn: (tx: unknown) => Promise<T>) => fn({}) };

  const passwords = new PasswordService(settings);
  const hasher = new KeyedHasher(settings);
  const service = new AuthService(
    usersRepo as unknown as UsersRepository,
    sessionsRepo as unknown as SessionsRepository,
    authTokensRepo as unknown as AuthTokensRepository,
    attemptsRepo as unknown as LoginAttemptsRepository,
    passwords,
    new AccessTokenService(new JwtService(), settings),
    hasher,
    jobsService as unknown as JobsService,
    eventsService as unknown as SecurityEventsService,
    uow as unknown as UnitOfWork,
    settings,
    clock,
  );

  /** Adds a user directly (as if registered and optionally verified). */
  async function addUser(email: string, password: string, verified = true): Promise<UserRecord> {
    const user: UserRecord = {
      id: randomUUID(),
      email,
      fullName: 'Test User',
      isActive: true,
      passwordHash: await passwords.hash(password),
      emailVerifiedAt: verified ? clock.now() : null,
      isPlatformAdmin: false,
      createdAt: clock.now(),
    };
    users.push(user);
    return user;
  }

  /** Stores a one-time token as the email job would and returns the raw value the user receives. */
  function addAuthToken(userId: string, purpose: AuthTokenPurposeValue, ttlSeconds = 3600): string {
    const raw = `raw-${randomUUID()}-${randomUUID()}`;
    authTokens.push({
      userId,
      purpose,
      tokenHash: sha256Hex(raw),
      expiresAt: new Date(clock.now().getTime() + ttlSeconds * 1000),
      consumedAt: null,
    });
    return raw;
  }

  return {
    service,
    clock,
    settings,
    passwords,
    users,
    sessions,
    refreshTokens,
    authTokens,
    attempts,
    jobs,
    events,
    addUser,
    addAuthToken,
  };
}

export const CLIENT = { ip: '203.0.113.7', userAgent: 'vitest' };
