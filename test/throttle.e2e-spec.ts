import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { configureApp } from '../src/common/http/configure-app.js';

/** Rate limiting is off in the shared test environment; this file turns it on with a tiny limit. */
describe('rate limiting', () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.THROTTLE_ENABLED = 'true';
    process.env.THROTTLE_LIMIT = '3';
    // ConfigModule validates the environment when AppModule is first imported, so import it only now.
    const { AppModule } = await import('../src/app.module.js');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
  });
  afterAll(async () => {
    await app.close();
  });

  it('cuts a flood with 429 problem+json and Retry-After BEFORE authentication runs', async () => {
    const http = () => request(app.getHttpServer()).get('/api/v1/me');
    // if authentication ran first these would stay 401 forever
    await http().expect(401);
    await http().expect(401);
    await http().expect(401);
    const response = await http().expect(429);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.body).toMatchObject({ status: 429, code: 'RATE_LIMITED' });
    expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('never rate limits the health probes', async () => {
    for (let i = 0; i < 10; i++)
      await request(app.getHttpServer()).get('/api/v1/health').expect(200);
  });
});
