import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROLES, roleHas, type Role } from '../../src/permissions/catalogue.js';
import { createIntContext, type IntContext } from '../support/int-context.js';
import {
  as,
  createOrganisationWithAllRoles,
  createPerson,
  type Member,
  type Person,
} from '../support/people.js';
import { discoverRoutes, fillPath, type DiscoveredRoute } from '../support/routes.js';

const routes = (await discoverRoutes()).filter(
  (route) => route.template.includes(':organisationId') && route.access !== 'platform', // platform routes name an organisation but are not organisation-scoped
);

/**
 * The GENERATED tenancy and RBAC matrix (testing-and-quality skill). It walks every organisation
 * route found in the controllers, so a new endpoint is covered the moment it exists, and checks the
 * same table of outcomes for each one:
 *
 *   anonymous                          -> 401
 *   member of ANOTHER organisation     -> 404 (never 403: existence is not confirmed)
 *   deactivated member                 -> 404
 *   platform administrator, no member  -> 404 (the flag gives no tenant access)
 *   member whose role lacks the key    -> 403, decided before anything is looked up
 *   member whose role holds the key    -> passes the guard (any answer but 401/403, and a 404 only
 *                                         from the handler, never from the guard)
 *
 * Requests carry an empty body and an id that exists nowhere, so allowed callers stop at validation
 * or "not found" and nothing is ever changed.
 */
describe('generated tenancy and RBAC matrix', () => {
  let ctx: IntContext;
  let organisationId: string;
  let members: Record<Role, Member>;
  let outsider: Person;
  let deactivated: Person;
  let platformAdmin: Person;
  const tag = randomUUID().slice(0, 8);

  beforeAll(async () => {
    ctx = await createIntContext();
    const a = await createOrganisationWithAllRoles(ctx, `matrix-a-${tag}`);
    const b = await createOrganisationWithAllRoles(ctx, `matrix-b-${tag}`);
    organisationId = a.organisation.id;
    members = a.byRole;
    outsider = b.byRole.COMPANY_OWNER;
    deactivated = await createPerson(ctx, { label: `ex-owner-${tag}` });
    await ctx.admin.membership.create({
      data: {
        organisationId,
        userId: deactivated.id,
        role: 'COMPANY_OWNER',
        status: 'DEACTIVATED',
      },
    });
    platformAdmin = await createPerson(ctx, { label: `platform-${tag}` });
    await ctx.admin.user.update({
      where: { id: platformAdmin.id },
      data: { isPlatformAdmin: true },
    });
  });
  afterAll(async () => {
    await ctx.close();
  });

  const call = (route: DiscoveredRoute, caller?: Person) => {
    const request = ctx.http()[route.verb](fillPath(route.template, organisationId));
    if (caller) request.set(as(caller));
    return route.verb === 'get' ? request : request.send({});
  };

  it('finds the organisation routes it is meant to cover', () => {
    expect(routes.length).toBeGreaterThanOrEqual(9);
    for (const route of routes) {
      expect(['permission', 'organisation-member'], route.handler).toContain(route.access);
    }
  });

  it.each(routes.map((route) => [`${route.verb.toUpperCase()} ${route.template}`, route] as const))(
    '%s',
    async (_label, route) => {
      // not signed in
      expect((await call(route)).status).toBe(401);

      // signed in, but a stranger to this organisation: always 404, whatever the role elsewhere
      for (const stranger of [outsider, deactivated, platformAdmin]) {
        const response = await call(route, stranger);
        expect(response.status, `${route.handler} for a non-member`).toBe(404);
        expect(response.body.code).toBe('NOT_FOUND');
      }

      // every role: exactly what the catalogue says
      for (const role of ROLES) {
        const response = await call(route, members[role]);
        const allowed = route.permission ? roleHas(role, route.permission) : true;
        if (!allowed) {
          expect(response.status, `${route.handler} as ${role}`).toBe(403);
          expect(response.body.code).toBe('FORBIDDEN');
        } else {
          expect([401, 403], `${route.handler} as ${role}`).not.toContain(response.status);
          if (response.status === 404) {
            // a handler may say "no such record"; the guard's answer is a different message
            expect(response.body.detail, `${route.handler} as ${role}`).not.toBe(
              'Resource not found.',
            );
          }
        }
      }
    },
  );

  it('answers an organisation id that does not exist exactly like a stranger (404)', async () => {
    const unknown = await ctx
      .http()
      .get('/api/v1/organisations/0198a0f6-7c2e-7a53-9b1e-ffffffffffff/members')
      .set(as(members.COMPANY_OWNER));
    expect(unknown.status).toBe(404);
    const malformed = await ctx
      .http()
      .get('/api/v1/organisations/not-a-uuid/members')
      .set(as(members.COMPANY_OWNER));
    expect(malformed.status).toBe(404);
  });
});
