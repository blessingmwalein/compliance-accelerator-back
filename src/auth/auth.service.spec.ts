import { describe, expect, it, vi } from 'vitest';
import { AUTH_JOB_TYPES } from './auth-jobs.js';
import { CLIENT, createAuthWorld } from '../../test/support/auth-world.js';
import { sha256Hex } from './tokens.js';

const PASSWORD = 'purple-stapler-moon-77';

/** Runs a call and returns the AppException details (or 'OK'), so assertions read like a table. */
async function outcome(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'OK';
  } catch (error) {
    const e = error as {
      code?: string;
      getStatus?: () => number;
      headers?: Record<string, string>;
    };
    return `${e.getStatus?.() ?? '?'} ${e.code ?? (error as Error).message}`;
  }
}

describe('AuthService.register', () => {
  it('creates an unverified account with a hashed password and queues the confirmation email', async () => {
    const w = createAuthWorld();
    await w.service.register(
      { email: 'new@example.com', password: PASSWORD, fullName: 'New Person' },
      CLIENT,
    );

    expect(w.users).toHaveLength(1);
    expect(w.users[0]).toMatchObject({ email: 'new@example.com', emailVerifiedAt: null });
    expect(w.users[0]!.passwordHash).toMatch(/^\$argon2id\$/);
    expect(w.users[0]!.passwordHash).not.toContain(PASSWORD);
    expect(w.jobs.map((j) => j.type)).toEqual([AUTH_JOB_TYPES.sendVerification]);
    expect(w.jobs[0]!.payload).toEqual({ userId: w.users[0]!.id }); // ids only
    expect(w.events.map((e) => e.type)).toEqual(['auth.registered']);
  });

  it('rejects a weak password with field errors and creates nothing', async () => {
    const w = createAuthWorld();
    const result = await outcome(
      w.service.register({ email: 'a@example.com', password: 'short', fullName: 'A' }, CLIENT),
    );
    expect(result).toBe('400 VALIDATION_FAILED');
    expect(w.users).toHaveLength(0);
    expect(w.jobs).toHaveLength(0);
  });

  it('is uniform: registering an address that already exists resolves the same way and changes nothing', async () => {
    const w = createAuthWorld();
    const existing = await w.addUser('taken@example.com', PASSWORD, true);
    const hashBefore = existing.passwordHash;

    expect(
      await outcome(
        w.service.register(
          {
            email: 'taken@example.com',
            password: 'another-long-passphrase-9',
            fullName: 'Someone',
          },
          CLIENT,
        ),
      ),
    ).toBe('OK');
    expect(w.users).toHaveLength(1);
    expect(w.users[0]!.passwordHash).toBe(hashBefore);
    expect(w.jobs.map((j) => j.type)).toEqual([AUTH_JOB_TYPES.sendAccountExists]);
    expect(w.events.map((e) => e.type)).toEqual(['auth.registration_ignored_existing']);
  });

  it('never overwrites the password of an existing UNVERIFIED account (a stranger could take it over), but re-sends the link', async () => {
    const w = createAuthWorld();
    const existing = await w.addUser('pending@example.com', PASSWORD, false);
    const hashBefore = existing.passwordHash;

    await w.service.register(
      {
        email: 'pending@example.com',
        password: 'attackers-chosen-passphrase-1',
        fullName: 'Mallory',
      },
      CLIENT,
    );
    expect(w.users[0]!.passwordHash).toBe(hashBefore);
    expect(w.users[0]!.fullName).toBe('Test User');
    expect(w.jobs.map((j) => j.type)).toEqual([AUTH_JOB_TYPES.sendVerification]);
  });

  it('throttles repeated emails with a deterministic dedupe key, then allows another after the window', async () => {
    const w = createAuthWorld();
    await w.addUser('pending@example.com', PASSWORD, false);
    const again = () =>
      w.service.register(
        { email: 'pending@example.com', password: PASSWORD, fullName: 'X' },
        CLIENT,
      );
    await again();
    await again();
    expect(w.jobs).toHaveLength(1);
    w.clock.advance(6 * 60);
    await again();
    expect(w.jobs).toHaveLength(2);
  });

  it('handles two simultaneous registrations of one address (unique violation) like "already registered"', async () => {
    const w = createAuthWorld();
    // the loser's create() throws a unique violation because the winner's row appears between check and insert
    const loser = createAuthWorld();
    const racing = await loser.addUser('race@example.com', PASSWORD, false);
    const original = loser.service['users'].findByEmail.bind(loser.service['users']);
    let first = true;
    loser.service['users'].findByEmail = vi.fn(async (email: string) => {
      if (first) {
        first = false;
        return null; // the pre-check sees nothing yet
      }
      return original(email);
    });
    expect(
      await outcome(
        loser.service.register(
          { email: 'race@example.com', password: PASSWORD, fullName: 'R' },
          CLIENT,
        ),
      ),
    ).toBe('OK');
    expect(loser.users).toEqual([racing]);
    expect(w.users).toHaveLength(0);
  });
});

describe('AuthService.verifyEmail', () => {
  it('confirms the address once; replaying the same token fails', async () => {
    const w = createAuthWorld();
    const user = await w.addUser('v@example.com', PASSWORD, false);
    const token = w.addAuthToken(user.id, 'EMAIL_VERIFICATION');

    await w.service.verifyEmail(token);
    expect(w.users[0]!.emailVerifiedAt).not.toBeNull();
    expect(await outcome(w.service.verifyEmail(token))).toBe('400 INVALID_TOKEN');
  });

  it('rejects unknown, expired and wrong-purpose tokens with the same error', async () => {
    const w = createAuthWorld();
    const user = await w.addUser('v@example.com', PASSWORD, false);
    const expired = w.addAuthToken(user.id, 'EMAIL_VERIFICATION', 60);
    w.clock.advance(61);
    const resetToken = w.addAuthToken(user.id, 'PASSWORD_RESET');

    expect(await outcome(w.service.verifyEmail('x'.repeat(43)))).toBe('400 INVALID_TOKEN');
    expect(await outcome(w.service.verifyEmail(expired))).toBe('400 INVALID_TOKEN');
    expect(await outcome(w.service.verifyEmail(resetToken))).toBe('400 INVALID_TOKEN');
    expect(w.users[0]!.emailVerifiedAt).toBeNull();
  });

  it('resendVerification is uniform and only queues for an unverified, active account', async () => {
    const w = createAuthWorld();
    await w.addUser('unverified@example.com', PASSWORD, false);
    await w.addUser('verified@example.com', PASSWORD, true);

    for (const email of ['unverified@example.com', 'verified@example.com', 'nobody@example.com']) {
      expect(await outcome(w.service.resendVerification(email, CLIENT))).toBe('OK');
    }
    expect(w.jobs).toHaveLength(1);
    expect(w.jobs[0]!.type).toBe(AUTH_JOB_TYPES.sendVerification);
  });
});

describe('AuthService.login', () => {
  it('signs in a verified user and stores only the hash of the refresh token', async () => {
    const w = createAuthWorld();
    const user = await w.addUser('ok@example.com', PASSWORD);

    const issued = await w.service.login({ email: 'ok@example.com', password: PASSWORD }, CLIENT);
    expect(issued.accessToken.split('.')).toHaveLength(3);
    expect(issued.expiresInSeconds).toBe(900);
    expect(issued.refreshToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(w.refreshTokens.has(sha256Hex(issued.refreshToken))).toBe(true);
    expect(w.refreshTokens.has(issued.refreshToken)).toBe(false);
    expect(w.sessions.size).toBe(1);
    expect(w.users.find((u) => u.id === user.id)).toBeDefined();
    expect(w.events.map((e) => e.type)).toContain('auth.login_succeeded');
    expect(issued.refreshMaxAgeMs).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it('gives the same answer for a wrong password and an unknown address (no enumeration)', async () => {
    const w = createAuthWorld();
    await w.addUser('real@example.com', PASSWORD);
    const dummy = vi.spyOn(w.passwords, 'verifyDummy');

    const wrong = await outcome(
      w.service.login({ email: 'real@example.com', password: 'not-the-password-1' }, CLIENT),
    );
    const unknown = await outcome(
      w.service.login({ email: 'ghost@example.com', password: 'not-the-password-1' }, CLIENT),
    );
    expect(wrong).toBe('401 INVALID_CREDENTIALS');
    expect(unknown).toBe(wrong);
    expect(dummy).toHaveBeenCalledTimes(1); // the unknown address still paid for a hash verification
    expect(w.attempts.map((a) => a.succeeded)).toEqual([false, false]);
  });

  it('refuses an unverified account only AFTER the password proved right, and does not count it as a failure', async () => {
    const w = createAuthWorld();
    await w.addUser('new@example.com', PASSWORD, false);
    expect(
      await outcome(
        w.service.login({ email: 'new@example.com', password: 'wrong-wrong-wrong-1' }, CLIENT),
      ),
    ).toBe('401 INVALID_CREDENTIALS');
    expect(
      await outcome(w.service.login({ email: 'new@example.com', password: PASSWORD }, CLIENT)),
    ).toBe('403 EMAIL_NOT_VERIFIED');
    expect(w.sessions.size).toBe(0);
  });

  it('treats a deactivated user like any wrong credential', async () => {
    const w = createAuthWorld();
    const user = await w.addUser('off@example.com', PASSWORD);
    user.isActive = false;
    expect(
      await outcome(w.service.login({ email: 'off@example.com', password: PASSWORD }, CLIENT)),
    ).toBe('401 INVALID_CREDENTIALS');
  });

  it('locks the account after 5 failures with Retry-After, even for the correct password, and for unknown addresses too', async () => {
    const w = createAuthWorld();
    await w.addUser('victim@example.com', PASSWORD);
    for (let i = 0; i < 5; i++) {
      await outcome(
        w.service.login(
          { email: 'victim@example.com', password: `guess-number-${i}-aaaa` },
          CLIENT,
        ),
      );
      await outcome(
        w.service.login(
          { email: 'ghost@example.com', password: `guess-number-${i}-aaaa` },
          { ...CLIENT, ip: `198.51.100.${i}` },
        ),
      );
    }

    let headers: Record<string, string> | undefined;
    for (const email of ['victim@example.com', 'ghost@example.com']) {
      const error = await w.service
        .login({ email, password: PASSWORD }, { ...CLIENT, ip: '192.0.2.9' })
        .catch((e) => e);
      expect(error.code).toBe('RATE_LIMITED');
      expect(error.getStatus()).toBe(429);
      headers = error.headers;
      expect(Number(headers!['Retry-After'])).toBeGreaterThan(0);
      expect(Number(headers!['Retry-After'])).toBeLessThanOrEqual(30);
    }

    // after the lock expires the correct password works
    w.clock.advance(31);
    await expect(
      w.service.login({ email: 'victim@example.com', password: PASSWORD }, CLIENT),
    ).resolves.toBeDefined();
  });

  it('a successful login resets the failure count', async () => {
    const w = createAuthWorld();
    await w.addUser('ok@example.com', PASSWORD);
    for (let i = 0; i < 4; i++)
      await outcome(
        w.service.login({ email: 'ok@example.com', password: `bad-guess-${i}-zzzz` }, CLIENT),
      );
    await w.service.login({ email: 'ok@example.com', password: PASSWORD }, CLIENT);
    for (let i = 0; i < 4; i++)
      await outcome(
        w.service.login({ email: 'ok@example.com', password: `bad-guess-${i}-zzzz` }, CLIENT),
      );
    expect(
      await outcome(w.service.login({ email: 'ok@example.com', password: PASSWORD }, CLIENT)),
    ).toBe('OK');
  });

  it('never stores the email or IP of a failed login in the clear (keyed hashes only)', async () => {
    const w = createAuthWorld();
    await outcome(
      w.service.login({ email: 'secret.person@example.com', password: 'whatever-long-1' }, CLIENT),
    );
    const stored = JSON.stringify([w.attempts, w.events]);
    expect(stored).not.toContain('secret.person');
    expect(stored).not.toContain(CLIENT.ip);
  });
});

describe('AuthService.refresh', () => {
  async function loggedIn(options: { refreshGraceSeconds?: number } = {}) {
    const w = createAuthWorld(options);
    const user = await w.addUser('r@example.com', PASSWORD);
    const first = await w.service.login({ email: 'r@example.com', password: PASSWORD }, CLIENT);
    const sessionId = [...w.sessions.keys()][0]!;
    return { w, user, first, sessionId };
  }

  it('rotates: the presented token is marked used and a different one is issued', async () => {
    const { w, first, sessionId } = await loggedIn();
    w.clock.advance(60);
    const second = await w.service.refresh(first.refreshToken, CLIENT);
    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect(w.refreshTokens.get(sha256Hex(first.refreshToken))!.usedAt).not.toBeNull();
    expect(w.refreshTokens.get(sha256Hex(second.refreshToken))!.usedAt).toBeNull();
    expect(w.sessions.get(sessionId)!.touchedAt).not.toBeNull();
    // the session's absolute lifetime does not slide
    expect(w.refreshTokens.get(sha256Hex(second.refreshToken))!.expiresAt).toEqual(
      w.sessions.get(sessionId)!.expiresAt,
    );
  });

  it('REUSE after the grace window revokes the whole session, including the newest token', async () => {
    const { w, first, sessionId } = await loggedIn();
    const second = await w.service.refresh(first.refreshToken, CLIENT);
    w.clock.advance(11); // beyond the 10 s grace

    expect(await outcome(w.service.refresh(first.refreshToken, CLIENT))).toBe(
      '401 UNAUTHENTICATED',
    );
    expect(w.sessions.get(sessionId)!.revokedReason).toBe('REFRESH_REUSE');
    expect(w.events.map((e) => e.type)).toContain('auth.refresh_reuse_detected');
    // the thief's AND the legitimate client's newest token are dead: the family is gone
    expect(await outcome(w.service.refresh(second.refreshToken, CLIENT))).toBe(
      '401 UNAUTHENTICATED',
    );
  });

  it('REUSE inside the grace window is a concurrent request: a fresh pair, the session survives', async () => {
    const { w, first, sessionId } = await loggedIn();
    const a = await w.service.refresh(first.refreshToken, CLIENT);
    w.clock.advance(3);
    const b = await w.service.refresh(first.refreshToken, CLIENT);
    expect(b.refreshToken).not.toBe(a.refreshToken);
    expect(w.sessions.get(sessionId)!.revokedAt).toBeNull();
    // both descendants work
    await expect(w.service.refresh(a.refreshToken, CLIENT)).resolves.toBeDefined();
    await expect(w.service.refresh(b.refreshToken, CLIENT)).resolves.toBeDefined();
  });

  it('with the grace disabled, any reuse revokes immediately', async () => {
    const { w, first } = await loggedIn({ refreshGraceSeconds: 0 });
    await w.service.refresh(first.refreshToken, CLIENT);
    expect(await outcome(w.service.refresh(first.refreshToken, CLIENT))).toBe(
      '401 UNAUTHENTICATED',
    );
    expect([...w.sessions.values()][0]!.revokedReason).toBe('REFRESH_REUSE');
  });

  it('rejects a missing, unknown, expired or revoked-session token, and a deactivated user', async () => {
    const { w, user, first, sessionId } = await loggedIn();
    expect(await outcome(w.service.refresh(undefined, CLIENT))).toBe('401 UNAUTHENTICATED');
    expect(await outcome(w.service.refresh('a'.repeat(43), CLIENT))).toBe('401 UNAUTHENTICATED');

    user.isActive = false;
    expect(await outcome(w.service.refresh(first.refreshToken, CLIENT))).toBe(
      '401 UNAUTHENTICATED',
    );
    user.isActive = true;

    w.sessions.get(sessionId)!.revokedAt = w.clock.now();
    expect(await outcome(w.service.refresh(first.refreshToken, CLIENT))).toBe(
      '401 UNAUTHENTICATED',
    );
  });

  it('rejects once the session passed its absolute lifetime (30 days), however often it was refreshed', async () => {
    const { w, first } = await loggedIn();
    let token = first.refreshToken;
    for (let day = 0; day < 29; day++) {
      w.clock.advance(24 * 60 * 60);
      token = (await w.service.refresh(token, CLIENT)).refreshToken;
    }
    w.clock.advance(2 * 24 * 60 * 60);
    expect(await outcome(w.service.refresh(token, CLIENT))).toBe('401 UNAUTHENTICATED');
  });
});

describe('AuthService.logout', () => {
  it('ends the session of the presented token, and refreshing afterwards fails', async () => {
    const w = createAuthWorld();
    await w.addUser('l@example.com', PASSWORD);
    const issued = await w.service.login({ email: 'l@example.com', password: PASSWORD }, CLIENT);
    await w.service.logout(issued.refreshToken);
    expect([...w.sessions.values()][0]!.revokedReason).toBe('LOGOUT');
    expect(await outcome(w.service.refresh(issued.refreshToken, CLIENT))).toBe(
      '401 UNAUTHENTICATED',
    );
  });

  it('is idempotent and uniform for missing, unknown or already-revoked tokens', async () => {
    const w = createAuthWorld();
    expect(await outcome(w.service.logout(undefined))).toBe('OK');
    expect(await outcome(w.service.logout('z'.repeat(43)))).toBe('OK');
    await w.addUser('l@example.com', PASSWORD);
    const issued = await w.service.login({ email: 'l@example.com', password: PASSWORD }, CLIENT);
    await w.service.logout(issued.refreshToken);
    expect(await outcome(w.service.logout(issued.refreshToken))).toBe('OK');
    expect(w.events.filter((e) => e.type === 'auth.logout')).toHaveLength(1);
  });
});

describe('AuthService password reset', () => {
  it('forgotPassword is uniform and queues one email per window for a real account', async () => {
    const w = createAuthWorld();
    await w.addUser('known@example.com', PASSWORD);
    expect(await outcome(w.service.forgotPassword('nobody@example.com', CLIENT))).toBe('OK');
    expect(w.jobs).toHaveLength(0);

    await w.service.forgotPassword('known@example.com', CLIENT);
    await w.service.forgotPassword('known@example.com', CLIENT);
    expect(w.jobs.map((j) => j.type)).toEqual([AUTH_JOB_TYPES.sendPasswordReset]);
    w.clock.advance(11 * 60);
    await w.service.forgotPassword('known@example.com', CLIENT);
    expect(w.jobs).toHaveLength(2);
  });

  it('resets the password once, ends EVERY session, verifies the address and queues a notice', async () => {
    const w = createAuthWorld();
    const user = await w.addUser('reset@example.com', PASSWORD, false);
    const one = await w.service
      .login({ email: 'reset@example.com', password: PASSWORD }, CLIENT)
      .catch(() => undefined);
    expect(one).toBeUndefined(); // unverified accounts cannot sign in yet
    user.emailVerifiedAt = w.clock.now();
    await w.service.login({ email: 'reset@example.com', password: PASSWORD }, CLIENT);
    await w.service.login({ email: 'reset@example.com', password: PASSWORD }, CLIENT);
    const oldHash = user.passwordHash;
    const token = w.addAuthToken(user.id, 'PASSWORD_RESET');
    const otherToken = w.addAuthToken(user.id, 'PASSWORD_RESET');

    await w.service.resetPassword({ token, password: 'a-brand-new-passphrase-42' });

    expect(user.passwordHash).not.toBe(oldHash);
    expect([...w.sessions.values()].every((s) => s.revokedReason === 'PASSWORD_RESET')).toBe(true);
    expect(w.jobs.map((j) => j.type)).toContain(AUTH_JOB_TYPES.sendPasswordChanged);
    expect(w.events.map((e) => e.type)).toContain('auth.password_reset_completed');
    // single use, and the other outstanding link died with it
    expect(
      await outcome(w.service.resetPassword({ token, password: 'yet-another-passphrase-43' })),
    ).toBe('400 INVALID_TOKEN');
    expect(
      await outcome(
        w.service.resetPassword({ token: otherToken, password: 'yet-another-passphrase-43' }),
      ),
    ).toBe('400 INVALID_TOKEN');
    // the new password works, the old one does not
    expect(
      await outcome(
        w.service.login(
          { email: 'reset@example.com', password: 'a-brand-new-passphrase-42' },
          CLIENT,
        ),
      ),
    ).toBe('OK');
    expect(
      await outcome(w.service.login({ email: 'reset@example.com', password: PASSWORD }, CLIENT)),
    ).toBe('401 INVALID_CREDENTIALS');
  });

  it('a successful reset proves the address, so an unverified account becomes verified', async () => {
    const w = createAuthWorld();
    const user = await w.addUser('pending@example.com', PASSWORD, false);
    const token = w.addAuthToken(user.id, 'PASSWORD_RESET');
    await w.service.resetPassword({ token, password: 'a-brand-new-passphrase-42' });
    expect(user.emailVerifiedAt).not.toBeNull();
  });

  it('a weak new password is rejected WITHOUT burning the token', async () => {
    const w = createAuthWorld();
    const user = await w.addUser('weak@example.com', PASSWORD);
    const token = w.addAuthToken(user.id, 'PASSWORD_RESET');
    expect(await outcome(w.service.resetPassword({ token, password: 'weak' }))).toBe(
      '400 VALIDATION_FAILED',
    );
    expect(
      await outcome(w.service.resetPassword({ token, password: 'weak@example-passphrase' })),
    ).toBe('400 VALIDATION_FAILED');
    expect(
      await outcome(w.service.resetPassword({ token, password: 'a-brand-new-passphrase-42' })),
    ).toBe('OK');
  });

  it('rejects unknown, expired and wrong-purpose tokens identically', async () => {
    const w = createAuthWorld();
    const user = await w.addUser('x@example.com', PASSWORD);
    const expired = w.addAuthToken(user.id, 'PASSWORD_RESET', 30);
    const verification = w.addAuthToken(user.id, 'EMAIL_VERIFICATION');
    w.clock.advance(31);
    for (const token of ['q'.repeat(43), expired, verification]) {
      expect(
        await outcome(w.service.resetPassword({ token, password: 'a-brand-new-passphrase-42' })),
      ).toBe('400 INVALID_TOKEN');
    }
  });
});
