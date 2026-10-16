import { RequestMethod } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import {
  ACCESS_METADATA_KEYS,
  PLATFORM_ONLY_KEY,
  REQUIRE_PERMISSION_KEY,
} from '../src/auth/access.decorators.js';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/common/http/configure-app.js';
import { buildOpenApiDocument } from '../src/common/http/openapi.js';
import { PERMISSIONS, PLATFORM_PERMISSIONS } from '../src/permissions/catalogue.js';

/**
 * "Every handler declares how it is protected" (security-and-rbac skill). Access is deny by default
 * at runtime anyway; this test makes the declaration explicit and reviewable, so nobody can add an
 * endpoint whose access was never considered, and checks that the contract states it.
 */
describe('every route handler declares its access', () => {
  it('has one of @Public, @Authenticated, @RequirePermission, @OrganisationMember or @PlatformOnly', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const discovery = moduleRef.get(DiscoveryService);

    const undeclared: string[] = [];
    const ambiguous: string[] = [];
    let handlers = 0;
    for (const wrapper of discovery.getControllers()) {
      const controller = wrapper.metatype;
      if (typeof controller !== 'function') continue;
      for (const name of Object.getOwnPropertyNames(controller.prototype)) {
        const handler = controller.prototype[name] as unknown;
        if (name === 'constructor' || typeof handler !== 'function') continue;
        const method = Reflect.getMetadata('method', handler) as RequestMethod | undefined;
        if (method === undefined) continue; // not a route handler
        handlers++;
        const declared = ACCESS_METADATA_KEYS.filter(
          (key) =>
            Reflect.getMetadata(key, handler) !== undefined ||
            Reflect.getMetadata(key, controller) !== undefined,
        );
        if (declared.length === 0) undeclared.push(`${controller.name}.${name}`);
        if (declared.length > 1)
          ambiguous.push(`${controller.name}.${name}: ${declared.join(', ')}`);
      }
    }
    await moduleRef.close();

    expect(handlers).toBeGreaterThan(25); // guards against scanning nothing
    expect(undeclared).toEqual([]);
    expect(ambiguous).toEqual([]);
  });

  it('writes x-access on every operation and a catalogue key in x-permission where there is one', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    const document = buildOpenApiDocument(app);
    await app.close();

    const accessKinds = new Set([
      'public',
      'authenticated',
      'permission',
      'organisation-member',
      'platform',
    ]);
    const known = new Set<string>([...PERMISSIONS, ...PLATFORM_PERMISSIONS]);
    const problems: string[] = [];
    let operations = 0;
    for (const [path, item] of Object.entries(document.paths)) {
      for (const [method, operation] of Object.entries(
        item as Record<string, Record<string, unknown>>,
      )) {
        if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
        operations++;
        const label = `${method.toUpperCase()} ${path}`;
        const access = operation['x-access'];
        if (typeof access !== 'string' || !accessKinds.has(access))
          problems.push(`${label}: x-access ${String(access)}`);
        const permission = operation['x-permission'];
        const needsPermission = access === 'permission' || access === 'platform';
        if (needsPermission && (typeof permission !== 'string' || !known.has(permission))) {
          problems.push(`${label}: x-permission ${String(permission)}`);
        }
        if (!needsPermission && permission !== undefined)
          problems.push(`${label}: unexpected x-permission`);
      }
    }
    expect(operations).toBeGreaterThan(25);
    expect(problems).toEqual([]);
  });

  it('keeps organisation routes behind authentication before any lookup (401, not 404)', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    const organisation = '0198a0f6-7c2e-7a53-9b1e-0123456789ab';
    const server = app.getHttpServer();

    for (const path of [
      `/api/v1/organisations/${organisation}/members`,
      `/api/v1/organisations/${organisation}/me`,
      `/api/v1/organisations/${organisation}/invitations`,
      '/api/v1/organisations',
      '/api/v1/platform/organisations',
    ]) {
      const anonymous = await request(server).get(path);
      expect(anonymous.status, path).toBe(401);
      const garbage = await request(server).get(path).set('Authorization', 'Bearer not-a-token');
      expect(garbage.status, path).toBe(401);
    }
    await app.close();
  });

  it('exports the metadata keys the guard reads (a rename must be deliberate)', () => {
    expect(REQUIRE_PERMISSION_KEY).toBe('fca:access:permission');
    expect(PLATFORM_ONLY_KEY).toBe('fca:access:platform-only');
  });
});
