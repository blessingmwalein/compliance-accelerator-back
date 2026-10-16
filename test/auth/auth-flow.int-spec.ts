import { randomUUID } from 'node:crypto';
import type { Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createIntContext, type IntContext } from '../support/int-context.js';
import { readMails, resetMailDir } from '../support/mail.js';

const MAIL_DIR = process.env.DEV_MAIL_DIR!;
const WEB = { 'X-Requested-With': 'fca-web', Origin: 'http://localhost:5173' };
const PASSWORD = 'purple-stapler-moon-77';
const NEW_PASSWORD = 'a-brand-new-passphrase-42';

const setCookieOf = (response: Response): string => {
  const cookies = (response.headers['set-cookie'] ?? []) as unknown as string[];
  const cookie = cookies.find((c) => c.startsWith('fca_refresh='));
  if (!cookie) throw new Error('no refresh cookie in the response');
  return cookie;
};
/** `fca_refresh=<token>` ready to send back as a Cookie header. */
const cookieHeader = (response: Response): string => setCookieOf(response).split(';')[0]!;

describe('authentication on a real database', () => {
  let ctx: IntContext;
  const tag = randomUUID().slice(0, 8);
  let counter = 0;
  const newEmail = () => `auth-${tag}-${++counter}@example.test`;

  beforeAll(async () => {
    await resetMailDir(MAIL_DIR);
    ctx = await createIntContext();
  });
  afterAll(async () => {
    await ctx.close();
  });

  const drain = () => ctx.runner.runBatch({ limit: 50 });
  const mailsTo = async (email: string) =>
    (await readMails(MAIL_DIR)).filter((m) => m.to === email);

  async function registerAndVerify(email: string, password = PASSWORD) {
    await ctx
      .http()
      .post('/api/v1/auth/register')
      .send({ email, password, fullName: 'Flow Tester' })
      .expect(202);
    await drain();
    const [verification] = await mailsTo(email);
    await ctx
      .http()
      .post('/api/v1/auth/verify-email')
      .send({ token: verification!.token })
      .expect(204);
  }

  const login = (email: string, password = PASSWORD) =>
    ctx.http().post('/api/v1/auth/login').send({ email, password });

  it('register -> email -> confirm -> sign in -> /me, with nothing secret at rest', async () => {
    const email = newEmail();

    const registered = await ctx
      .http()
      .post('/api/v1/auth/register')
      .send({ email, password: PASSWORD, fullName: 'Flow Tester' })
      .expect(202);
    expect(registered.body).toEqual({ accepted: true });
    expect((await drain()).succeeded).toBeGreaterThanOrEqual(1);

    const mails = await mailsTo(email);
    expect(mails).toHaveLength(1);
    const verification = mails[0]!;
    expect(verification.links[0]).toMatch(
      /^http:\/\/localhost:5173\/verify-email#token=[A-Za-z0-9_-]{43}$/,
    );

    // cannot sign in before the address is confirmed, even with the right password
    const early = await login(email).expect(403);
    expect(early.body).toMatchObject({ code: 'EMAIL_NOT_VERIFIED' });

    await ctx
      .http()
      .post('/api/v1/auth/verify-email')
      .send({ token: verification.token })
      .expect(204);
    // the link works exactly once
    const replay = await ctx
      .http()
      .post('/api/v1/auth/verify-email')
      .send({ token: verification.token })
      .expect(400);
    expect(replay.body).toMatchObject({ code: 'INVALID_TOKEN' });

    const signedIn = await login(email).expect(200);
    expect(signedIn.body).toMatchObject({ tokenType: 'Bearer', expiresInSeconds: 900 });
    const cookie = setCookieOf(signedIn);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/api/v1/auth');

    const me = await ctx
      .http()
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${signedIn.body.accessToken}`)
      .expect(200);
    expect(me.body).toMatchObject({ email, fullName: 'Flow Tester', emailVerified: true });
    expect(me.body).not.toHaveProperty('passwordHash');
    expect(JSON.stringify(me.body)).not.toContain('argon2');

    // --- at rest: hashes, never secrets
    const user = await ctx.admin.user.findUniqueOrThrow({ where: { email } });
    expect(user.passwordHash).toMatch(/^\$argon2id\$/);
    const rawRefresh = cookieHeader(signedIn).split('=')[1]!;
    expect(await ctx.admin.refreshToken.count({ where: { tokenHash: rawRefresh } })).toBe(0);
    expect(await ctx.admin.refreshToken.count({ where: { session: { userId: user.id } } })).toBe(1);
    const token = await ctx.admin.authToken.findFirstOrThrow({ where: { userId: user.id } });
    expect(token.tokenHash).not.toBe(verification.token);
    expect(token.consumedAt).not.toBeNull();
    const jobs = await ctx.admin.job.findMany({
      where: { payload: { path: ['userId'], equals: user.id } },
    });
    expect(jobs.length).toBeGreaterThan(0);
    for (const job of jobs) {
      expect(Object.keys(job.payload as object)).toEqual(['userId']);
      expect(job.status).toBe('SUCCEEDED');
    }
    const deliveries = await ctx.admin.emailDelivery.findMany({ where: { toAddress: email } });
    expect(deliveries.map((d) => [d.template, d.status])).toEqual([['verify-email', 'SENT']]);
    const types = (
      await ctx.admin.securityEvent.findMany({
        where: { userId: user.id },
        orderBy: { occurredAt: 'asc' },
      })
    ).map((e) => e.eventType);
    expect(types).toEqual(
      expect.arrayContaining([
        'auth.registered',
        'auth.login_unverified',
        'auth.email_verified',
        'auth.login_succeeded',
      ]),
    );
  });

  it('rotates the refresh cookie; reuse inside the grace window is tolerated, reuse after it kills the session', async () => {
    const email = newEmail();
    await registerAndVerify(email);
    const first = await login(email).expect(200);
    const sessionBefore = await ctx.admin.session.findFirstOrThrow({ where: { user: { email } } });

    const r1 = cookieHeader(first);
    const second = await ctx
      .http()
      .post('/api/v1/auth/refresh')
      .set(WEB)
      .set('Cookie', r1)
      .expect(200);
    const r2 = cookieHeader(second);
    expect(r2).not.toBe(r1);

    // concurrent-looking reuse (inside the 10 s grace): a fresh pair, the session lives on
    const raced = await ctx
      .http()
      .post('/api/v1/auth/refresh')
      .set(WEB)
      .set('Cookie', r1)
      .expect(200);
    const r3 = cookieHeader(raced);
    expect(
      await ctx.admin.session.findUniqueOrThrow({ where: { id: sessionBefore.id } }),
    ).toMatchObject({ revokedAt: null });

    // age every used token past the grace window, then replay the stolen one
    await ctx.admin
      .$executeRaw`UPDATE refresh_tokens SET used_at = now() - interval '5 minutes' WHERE used_at IS NOT NULL`;
    const stolen = await ctx
      .http()
      .post('/api/v1/auth/refresh')
      .set(WEB)
      .set('Cookie', r1)
      .expect(401);
    expect(stolen.body).toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(setCookieOf(stolen)).toContain('fca_refresh=;'); // the browser's cookie is cleared too

    const session = await ctx.admin.session.findUniqueOrThrow({ where: { id: sessionBefore.id } });
    expect(session.revokedAt).not.toBeNull();
    expect(session.revokedReason).toBe('REFRESH_REUSE');
    // the whole family is dead: the legitimate newest tokens and the access token stop working
    await ctx.http().post('/api/v1/auth/refresh').set(WEB).set('Cookie', r2).expect(401);
    await ctx.http().post('/api/v1/auth/refresh').set(WEB).set('Cookie', r3).expect(401);
    await ctx
      .http()
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${raced.body.accessToken}`)
      .expect(401);
    expect(
      await ctx.admin.securityEvent.count({
        where: { eventType: 'auth.refresh_reuse_detected', user: { email } },
      }),
    ).toBe(1);
  });

  it('logout ends the session immediately, even for an access token that has not expired', async () => {
    const email = newEmail();
    await registerAndVerify(email);
    const signedIn = await login(email).expect(200);
    const bearer = `Bearer ${signedIn.body.accessToken}`;
    await ctx.http().get('/api/v1/me').set('Authorization', bearer).expect(200);

    const out = await ctx
      .http()
      .post('/api/v1/auth/logout')
      .set(WEB)
      .set('Cookie', cookieHeader(signedIn))
      .expect(204);
    expect(setCookieOf(out)).toContain('fca_refresh=;');

    await ctx.http().get('/api/v1/me').set('Authorization', bearer).expect(401);
    await ctx
      .http()
      .post('/api/v1/auth/refresh')
      .set(WEB)
      .set('Cookie', cookieHeader(signedIn))
      .expect(401);
  });

  it('password reset: one-time link, ends every session, notice email, old password dead', async () => {
    const email = newEmail();
    await registerAndVerify(email);
    const sessionA = await login(email).expect(200);
    const sessionB = await login(email).expect(200);

    await ctx.http().post('/api/v1/auth/forgot-password').send({ email }).expect(202);
    await drain();
    const resetMail = (await mailsTo(email)).find((m) =>
      m.subject.toLowerCase().includes('reset'),
    )!;
    expect(resetMail.links[0]).toMatch(/\/reset-password#token=/);

    // a weak password is rejected and does NOT burn the link
    const weak = await ctx
      .http()
      .post('/api/v1/auth/reset-password')
      .send({ token: resetMail.token, password: 'short' })
      .expect(400);
    expect(weak.body).toMatchObject({ code: 'VALIDATION_FAILED' });

    await ctx
      .http()
      .post('/api/v1/auth/reset-password')
      .send({ token: resetMail.token, password: NEW_PASSWORD })
      .expect(204);
    await ctx
      .http()
      .post('/api/v1/auth/reset-password')
      .send({ token: resetMail.token, password: 'yet-another-passphrase-9' })
      .expect(400);

    for (const session of [sessionA, sessionB]) {
      await ctx
        .http()
        .get('/api/v1/me')
        .set('Authorization', `Bearer ${session.body.accessToken}`)
        .expect(401);
      await ctx
        .http()
        .post('/api/v1/auth/refresh')
        .set(WEB)
        .set('Cookie', cookieHeader(session))
        .expect(401);
    }
    await login(email, PASSWORD).expect(401);
    await login(email, NEW_PASSWORD).expect(200);

    await drain();
    expect(
      (await mailsTo(email)).some((m) => m.subject.toLowerCase().includes('was changed')),
    ).toBe(true);
  });

  it('locks an account after repeated failures, with Retry-After, without revealing whether it exists', async () => {
    const email = newEmail();
    await registerAndVerify(email);
    const ghost = newEmail(); // never registered

    for (let i = 0; i < 5; i++) {
      await login(email, `wrong-guess-number-${i}-x`).expect(401);
      await login(ghost, `wrong-guess-number-${i}-x`).expect(401);
    }
    const lockedReal = await login(email, PASSWORD).expect(429);
    const lockedGhost = await login(ghost, PASSWORD).expect(429);
    for (const response of [lockedReal, lockedGhost]) {
      expect(response.body).toMatchObject({ code: 'RATE_LIMITED' });
      expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
    }

    // counters hold keyed hashes only: neither address appears in the clear
    const attempts = JSON.stringify(await ctx.admin.loginAttempt.findMany());
    const events = JSON.stringify(await ctx.admin.securityEvent.findMany());
    for (const address of [email, ghost]) {
      expect(attempts).not.toContain(address);
      expect(events).not.toContain(address);
    }
    expect(attempts).not.toContain('127.0.0.1');
  });

  it('answers identically whether or not an address is registered', async () => {
    const email = newEmail();
    await registerAndVerify(email);

    const again = await ctx
      .http()
      .post('/api/v1/auth/register')
      .send({ email, password: 'another-long-passphrase-9', fullName: 'Someone Else' })
      .expect(202);
    const fresh = await ctx
      .http()
      .post('/api/v1/auth/register')
      .send({ email: newEmail(), password: PASSWORD, fullName: 'New' })
      .expect(202);
    expect(again.body).toEqual(fresh.body);

    const forgotKnown = await ctx
      .http()
      .post('/api/v1/auth/forgot-password')
      .send({ email })
      .expect(202);
    const forgotUnknown = await ctx
      .http()
      .post('/api/v1/auth/forgot-password')
      .send({ email: newEmail() })
      .expect(202);
    expect(forgotKnown.body).toEqual(forgotUnknown.body);

    await drain();
    const subjects = (await mailsTo(email)).map((m) => m.subject);
    expect(subjects.some((s) => s.includes('already has an account'))).toBe(true);
    // the registered account's password was not touched by the second registration
    await login(email, PASSWORD).expect(200);
    await login(email, 'another-long-passphrase-9').expect(401);
  });

  it('repeated requests inside the window queue only one email (deterministic dedupe key)', async () => {
    const email = newEmail();
    await registerAndVerify(email);
    for (let i = 0; i < 4; i++)
      await ctx.http().post('/api/v1/auth/forgot-password').send({ email }).expect(202);
    await drain();
    const resets = (await mailsTo(email)).filter((m) => m.subject.toLowerCase().includes('reset'));
    expect(resets).toHaveLength(1);
  });
});
