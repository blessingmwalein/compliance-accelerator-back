import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { configureApp } from '../src/common/http/configure-app.js';
import { signTick } from '../src/jobs/tick-signature.js';

describe('the job tick endpoint without a configured secret', () => {
  let app: INestApplication;

  beforeAll(async () => {
    delete process.env.JOBS_TICK_SECRET;
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

  it('does not exist (404), even for a request signed with some secret', async () => {
    const ts = Math.floor(Date.now() / 1000);
    await request(app.getHttpServer())
      .post('/api/v1/internal/jobs/tick')
      .set('X-FCA-Timestamp', String(ts))
      .set('X-FCA-Signature', signTick('any-secret-any-secret-any-secret-any', ts))
      .expect(404);
  });
});
