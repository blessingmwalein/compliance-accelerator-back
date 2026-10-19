import { Body, Controller, Get, Post, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ApiOperation } from '@nestjs/swagger';
import { IsString, MaxLength } from 'class-validator';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { Public } from '../src/auth/access.decorators.js';
import { configureApp } from '../src/common/http/configure-app.js';
import { DEFAULT_EVIDENCE_MAX_BYTES } from '../src/config/env.schema.js';
import { RequestContext } from '../src/tenancy/request-context.js';
import { CONTRACT_VERSION } from '../src/meta/contract-version.js';

class CreateThingDto {
  @IsString()
  @MaxLength(5)
  name!: string;
}

/** Test-only probe: no write endpoints exist in Phase 0, so this exercises the global pipe. */
@Public()
@Controller('test-validation')
class ValidationProbeController {
  @Post()
  @ApiOperation({ operationId: 'createProbeThing' })
  create(@Body() dto: CreateThingDto): CreateThingDto {
    return dto;
  }
}

/** Test-only probe: shows what the request scope holds inside a real handler. */
@Public()
@Controller('test-context')
class ContextProbeController {
  constructor(private readonly context: RequestContext) {}

  @Get()
  @ApiOperation({ operationId: 'probeRequestContext' })
  probe(): { requestId: string | undefined; organisationId: string | undefined } {
    return { requestId: this.context.requestId, organisationId: this.context.organisationId };
  }
}

describe('HTTP surface (no database)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [ValidationProbeController, ContextProbeController],
    }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api/v1/health is live', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/health').expect(200);
    expect(response.body).toMatchObject({ status: 'ok' });
    expect(typeof response.body.uptimeSeconds).toBe('number');
  });

  it('opens a request scope whose request id is the X-Request-Id of the response, with no tenant yet', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/test-context')
      .set('X-Request-Id', 'e2e-request-42')
      .expect(200);
    expect(response.headers['x-request-id']).toBe('e2e-request-42');
    expect(response.body).toEqual({ requestId: 'e2e-request-42' });
  });

  it('GET /api/v1/health/ready reports 503 problem+json when no database is configured', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/health/ready').expect(503);
    expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(response.body).toMatchObject({
      status: 503,
      code: 'DATABASE_NOT_CONFIGURED',
      type: 'urn:fca:problem:database-not-configured',
    });
    expect(response.body.requestId).toBe(response.headers['x-request-id']);
  });

  it('GET /api/v1/meta returns the build and contract version', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/meta').expect(200);
    expect(response.body).toMatchObject({
      name: 'fca-backend',
      contractVersion: CONTRACT_VERSION,
      apiVersion: 'v1',
      // off unless the deployment enables it (ORGANISATIONS_SELF_SERVE)
      organisationSelfServe: false,
      // the cap an uploader must obey, stated by the server rather than assumed by the client
      evidenceMaxBytes: DEFAULT_EVIDENCE_MAX_BYTES,
    });
  });

  it('unknown routes return a 404 problem+json with a request id', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/nope').expect(404);
    expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(response.body).toMatchObject({ status: 404, code: 'NOT_FOUND' });
    expect(response.body.requestId).toBeTruthy();
  });

  it('echoes a well-formed X-Request-Id and replaces a malformed one', async () => {
    const echoed = await request(app.getHttpServer())
      .get('/api/v1/meta')
      .set('X-Request-Id', 'client-req-0001')
      .expect(200);
    expect(echoed.headers['x-request-id']).toBe('client-req-0001');

    const replaced = await request(app.getHttpServer())
      .get('/api/v1/meta')
      .set('X-Request-Id', 'bad id with spaces')
      .expect(200);
    expect(replaced.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('malformed JSON bodies return a 400 problem+json', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/test-validation')
      .set('Content-Type', 'application/json')
      .send('{"name": ')
      .expect(400);
    expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(response.body.code).toBe('BAD_REQUEST');
  });

  it('validation failures list field errors and reject unknown properties (mass assignment)', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/test-validation')
      .send({ name: 'too long a name', organisationId: 'someone-elses-org' })
      .expect(400);
    expect(response.body.code).toBe('VALIDATION_FAILED');
    expect(response.body.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'name', code: 'maxLength' }),
        expect.objectContaining({ path: 'organisationId', code: 'whitelistValidation' }),
      ]),
    );
  });

  it('accepts a valid body', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/test-validation')
      .send({ name: 'ok' })
      .expect(201);
    expect(response.body).toEqual({ name: 'ok' });
  });

  it('allows the configured web origin via CORS and exposes X-Request-Id', async () => {
    const response = await request(app.getHttpServer())
      .options('/api/v1/meta')
      .set('Origin', 'http://localhost:5173')
      .set('Access-Control-Request-Method', 'GET')
      .expect(204);
    expect(response.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(response.headers['access-control-allow-credentials']).toBe('true');
    expect(response.headers['access-control-allow-headers']).toContain('X-Requested-With');

    const simple = await request(app.getHttpServer())
      .get('/api/v1/meta')
      .set('Origin', 'http://localhost:5173')
      .expect(200);
    expect(simple.headers['access-control-expose-headers']).toContain('X-Request-Id');
    expect(simple.headers['access-control-expose-headers']).toContain('Content-Disposition');
  });

  it('does not grant CORS to an unknown origin', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/meta')
      .set('Origin', 'https://evil.example.com')
      .expect(200);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('sets security headers and hides the framework', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/meta').expect(200);
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['cross-origin-resource-policy']).toBe('same-site');
    expect(response.headers['x-powered-by']).toBeUndefined();
  });

  it('declares a unique, explicit camelCase operationId on every operation', async () => {
    const document = await request(app.getHttpServer()).get('/api/docs-json').expect(200);
    const operations = Object.values(
      document.body.paths as Record<string, Record<string, { operationId: string }>>,
    ).flatMap((pathItem) => Object.values(pathItem));
    const ids = operations.map((operation) => operation.operationId);

    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      // no underscore => the explicit @ApiOperation({ operationId }) was provided
      expect(id).toMatch(/^[a-z][A-Za-z0-9]*$/);
    }
  });

  it('serves Swagger UI and the raw document, versioned with the contract', async () => {
    await request(app.getHttpServer()).get('/api/docs').expect(200);
    const document = await request(app.getHttpServer()).get('/api/docs-json').expect(200);
    expect(document.body.info.version).toBe(CONTRACT_VERSION);
    expect(document.body.servers).toEqual([{ url: '/api/v1', description: 'Versioned API root' }]);
    expect(Object.keys(document.body.paths)).toEqual(
      expect.arrayContaining(['/health', '/health/ready', '/meta']),
    );
  });
});
