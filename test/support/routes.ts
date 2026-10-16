import { RequestMethod } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module.js';
import {
  IS_PUBLIC_KEY,
  ORGANISATION_MEMBER_KEY,
  PLATFORM_ONLY_KEY,
  REQUIRE_PERMISSION_KEY,
  AUTHENTICATED_KEY,
} from '../../src/auth/access.decorators.js';
import type { Permission } from '../../src/permissions/catalogue.js';

export type HttpVerb = 'get' | 'post' | 'put' | 'delete' | 'patch';
const VERBS: Partial<Record<RequestMethod, HttpVerb>> = {
  [RequestMethod.GET]: 'get',
  [RequestMethod.POST]: 'post',
  [RequestMethod.PUT]: 'put',
  [RequestMethod.DELETE]: 'delete',
  [RequestMethod.PATCH]: 'patch',
};

export interface DiscoveredRoute {
  verb: HttpVerb;
  /** Express-style template, for example `/api/v1/organisations/:organisationId/members/:membershipId`. */
  template: string;
  handler: string;
  access: 'public' | 'authenticated' | 'permission' | 'organisation-member' | 'platform';
  /** Set when `access` is `permission`. */
  permission?: Permission;
}

const asArray = (value: unknown): string[] =>
  (Array.isArray(value) ? value : [value]).filter(
    (item): item is string => typeof item === 'string',
  );

/**
 * Every route of the application, read from the controllers' metadata (the same source Nest uses), so
 * the generated matrices cover an endpoint the moment it exists. Boots the module without a
 * database connection and closes it again.
 */
export async function discoverRoutes(): Promise<DiscoveredRoute[]> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const routes: DiscoveredRoute[] = [];
  for (const wrapper of moduleRef.get(DiscoveryService).getControllers()) {
    const controller = wrapper.metatype;
    if (typeof controller !== 'function') continue;
    const controllerPath = asArray(Reflect.getMetadata('path', controller))[0] ?? '';
    for (const name of Object.getOwnPropertyNames(controller.prototype)) {
      const handler = controller.prototype[name] as unknown;
      if (name === 'constructor' || typeof handler !== 'function') continue;
      const method = Reflect.getMetadata('method', handler) as RequestMethod | undefined;
      const verb = method === undefined ? undefined : VERBS[method];
      if (!verb) continue;
      const handlerPath = asArray(Reflect.getMetadata('path', handler))[0] ?? '';
      const read = (key: string): unknown =>
        Reflect.getMetadata(key, handler) ?? Reflect.getMetadata(key, controller);

      const permission = read(REQUIRE_PERMISSION_KEY) as Permission | undefined;
      const access: DiscoveredRoute['access'] = read(IS_PUBLIC_KEY)
        ? 'public'
        : read(PLATFORM_ONLY_KEY)
          ? 'platform'
          : permission
            ? 'permission'
            : read(ORGANISATION_MEMBER_KEY)
              ? 'organisation-member'
              : read(AUTHENTICATED_KEY)
                ? 'authenticated'
                : (() => {
                    throw new Error(`${controller.name}.${name} has no access declaration`);
                  })();
      const template = `/api/v1/${[controllerPath, handlerPath]
        .map((part) => part.replace(/^\/+|\/+$/g, ''))
        .filter(Boolean)
        .join('/')}`;
      routes.push({
        verb,
        template,
        handler: `${controller.name}.${name}`,
        access,
        ...(permission ? { permission } : {}),
      });
    }
  }
  await moduleRef.close();
  return routes;
}

/** Fills the path parameters: the organisation with `organisationId`, every other id with a UUID that exists nowhere. */
export function fillPath(template: string, organisationId: string): string {
  return template
    .replace(':organisationId', organisationId)
    .replace(/:[A-Za-z]+/g, '0198a0f6-7c2e-7a53-9b1e-ffffffffffff');
}
