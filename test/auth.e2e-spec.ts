import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/common/http/configure-app.js';
import { signTick } from '../src/jobs/tick-signature.js';
import { testEnv } from '../vitest.shared.js';

const ORIGIN = 'http://localhost:5173'; // the default CORS_ORIGINS

describe('authentication HTTP surface (no database)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
  });
  afterAll(async () => {
    await app.close();
  });

  const http = () => request(app.getHttpServer());

  describe('deny by default', () => {
    it('GET /me without a token is a 401 problem+json', async () => {
      const response = await http().get('/api/v1/me').expect(401);
      expect(response.headers['content-type']).toContain('application/problem+json');
      expect(response.body).toMatchObject({ status: 401, code: 'UNAUTHENTICATED' });
      expect(response.body.requestId).toBeTruthy();
    });

    it.each([
      ['a non-bearer scheme', 'Basic dXNlcjpwYXNz'],
      ['an empty bearer', 'Bearer '],
      ['garbage', 'Bearer not.a.jwt'],
      [
        'an unsigned alg:none token',
        `Bearer ${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from('{"sub":"a","sid":"b"}').toString('base64url')}.`,
      ],
    ])('GET /me with %s is a 401', async (_name, header) => {
      await http().get('/api/v1/me').set('Authorization', header).expect(401);
    });

    it('public endpoints stay reachable without a token', async () => {
      await http().get('/api/v1/health').expect(200);
      await http().get('/api/v1/meta').expect(200);
    });
  });

  describe('POST /auth/refresh and /auth/logout (cookie endpoints)', () => {
    it.each(['refresh', 'logout'])(
      '%s without the CSRF header is 403, even with a cookie',
      async (name) => {
        const response = await http()
          .post(`/api/v1/auth/${name}`)
          .set('Cookie', 'fca_refresh=abc')
          .expect(403);
        expect(response.body).toMatchObject({ code: 'FORBIDDEN' });
      },
    );

    it.each(['refresh', 'logout'])('%s from a foreign Origin is 403', async (name) => {
      await http()
        .post(`/api/v1/auth/${name}`)
        .set('X-Requested-With', 'fca-web')
        .set('Origin', 'https://evil.example.net')
        .expect(403);
    });

    it('refresh with the header but no cookie is 401 and clears the cookie with matching attributes', async () => {
      const response = await http()
        .post('/api/v1/auth/refresh')
        .set('X-Requested-With', 'fca-web')
        .set('Origin', ORIGIN)
        .expect(401);
      expect(response.body).toMatchObject({ code: 'UNAUTHENTICATED' });
      const cookie = (response.headers['set-cookie'] as unknown as string[]).join(';');
      expect(cookie).toContain('fca_refresh=;');
      expect(cookie).toContain('Path=/api/v1/auth');
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('SameSite=Lax');
    });

    it('logout without a cookie is an idempotent 204 that clears the cookie', async () => {
      const response = await http()
        .post('/api/v1/auth/logout')
        .set('X-Requested-With', 'fca-web')
        .expect(204);
      expect((response.headers['set-cookie'] as unknown as string[]).join(';')).toContain(
        'fca_refresh=;',
      );
    });

    it('the CORS preflight allows the CSRF header from the web origin', async () => {
      const response = await http()
        .options('/api/v1/auth/refresh')
        .set('Origin', ORIGIN)
        .set('Access-Control-Request-Method', 'POST')
        .set('Access-Control-Request-Headers', 'x-requested-with,content-type')
        .expect(204);
      expect(response.headers['access-control-allow-origin']).toBe(ORIGIN);
      expect(response.headers['access-control-allow-credentials']).toBe('true');
      expect(response.headers['access-control-allow-headers'].toLowerCase()).toContain(
        'x-requested-with',
      );
    });
  });

  describe('request validation', () => {
    it('login rejects a malformed email with a field error', async () => {
      const response = await http()
        .post('/api/v1/auth/login')
        .send({ email: 'nope', password: 'x' })
        .expect(400);
      expect(response.body).toMatchObject({ code: 'VALIDATION_FAILED' });
      expect(response.body.errors).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: 'email', code: 'isEmail' })]),
      );
    });

    it('register forbids properties it does not declare (mass assignment)', async () => {
      const response = await http()
        .post('/api/v1/auth/register')
        .send({
          email: 'a@example.com',
          password: 'a-long-passphrase-123',
          fullName: 'A',
          isPlatformAdmin: true,
          emailVerifiedAt: '2020-01-01',
        })
        .expect(400);
      const paths = response.body.errors.map((e: { path: string }) => e.path);
      expect(paths).toEqual(expect.arrayContaining(['isPlatformAdmin', 'emailVerifiedAt']));
    });

    it('register reports a weak password by code before touching the database', async () => {
      const response = await http()
        .post('/api/v1/auth/register')
        .send({ email: 'a@example.com', password: 'short', fullName: 'A' })
        .expect(400);
      expect(response.body.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: 'password', code: 'password.tooShort' }),
        ]),
      );
    });

    it.each(['verify-email', 'reset-password'])('%s requires a token', async (name) => {
      await http().post(`/api/v1/auth/${name}`).send({}).expect(400);
    });

    it('lower-cases and trims the email before validation', async () => {
      // an invalid password makes the service stop before any database access, proving the DTO accepted the email
      const response = await http()
        .post('/api/v1/auth/register')
        .send({ email: '  Mixed.Case@Example.COM ', password: 'short', fullName: 'A' })
        .expect(400);
      expect(response.body.errors.map((e: { path: string }) => e.path)).not.toContain('email');
    });
  });

  describe('when the database is unreachable', () => {
    it('answers 503 DATABASE_UNAVAILABLE with Retry-After instead of a generic 500', async () => {
      // the e2e environment has no database, so a valid request reaches the first query and fails
      const response = await http()
        .post('/api/v1/auth/login')
        .send({ email: 'someone@example.com', password: 'a-valid-looking-passphrase' })
        .expect(503);
      expect(response.headers['content-type']).toContain('application/problem+json');
      expect(response.body).toMatchObject({ status: 503, code: 'DATABASE_UNAVAILABLE' });
      expect(response.headers['retry-after']).toBe('5');
      expect(JSON.stringify(response.body)).not.toMatch(/127\.0\.0\.1|prisma|not-configured/i);
    });
  });

  describe('POST /internal/jobs/tick', () => {
    const path = '/api/v1/internal/jobs/tick';
    const nowSeconds = () => Math.floor(Date.now() / 1000);

    it('rejects a request with no signature', async () => {
      await http().post(path).expect(401);
    });

    it('rejects a wrong signature and a stale timestamp', async () => {
      await http()
        .post(path)
        .set('X-FCA-Timestamp', String(nowSeconds()))
        .set('X-FCA-Signature', 'deadbeef')
        .expect(401);
      const stale = nowSeconds() - 3600;
      await http()
        .post(path)
        .set('X-FCA-Timestamp', String(stale))
        .set('X-FCA-Signature', signTick(testEnv.JOBS_TICK_SECRET, stale))
        .expect(401);
    });

    it('a signature made with another secret is rejected', async () => {
      const ts = nowSeconds();
      await http()
        .post(path)
        .set('X-FCA-Timestamp', String(ts))
        .set('X-FCA-Signature', signTick('another-secret-another-secret-another-secret', ts))
        .expect(401);
    });

    it('is not part of the client contract', async () => {
      const document = (await http().get('/api/docs-json').expect(200)).body;
      expect(Object.keys(document.paths).some((p) => p.includes('internal'))).toBe(false);
    });
  });
});
