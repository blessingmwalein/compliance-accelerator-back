import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import {
  Authenticated,
  OrganisationMember,
  PlatformOnly,
  Public,
  RequirePermission,
} from '../auth/access.decorators.js';
import type { UsersRepository } from '../auth/users.repository.js';
import { AppException } from '../common/errors/app.exception.js';
import type { Role } from '../permissions/catalogue.js';
import { RequestContext } from '../tenancy/request-context.js';
import { AccessGuard } from './access.guard.js';
import type {
  MembershipLookupRepository,
  MembershipSummary,
} from './membership-lookup.repository.js';

class Handlers {
  @Public() open() {}
  @Authenticated() signedIn() {}
  @RequirePermission('users.view') listUsers() {}
  @RequirePermission('users.delete') removeUser() {}
  @OrganisationMember() mine() {}
  @PlatformOnly('platform.organisations.manage') provision() {}
  undeclared() {}
}

@Authenticated()
class ClassLevel {
  anything() {}
}

const ORG = '0198a0f6-7c2e-7a53-9b1e-0123456789ab';
const USER = '0198a0f6-7c2e-7a53-9b1e-0123456789cd';

const summary = (
  role: Role,
  status: MembershipSummary['status'] = 'ACTIVE',
): MembershipSummary => ({
  membershipId: 'm-1',
  role,
  status,
  version: 1,
  organisationName: 'Acme',
  organisationTimezone: 'Africa/Harare',
});

function setup(options: { membership?: MembershipSummary | null; platformAdmin?: boolean } = {}) {
  const requestContext = new RequestContext();
  const find = vi.fn(async () => options.membership ?? null);
  const isPlatformAdmin = vi.fn(async () => options.platformAdmin ?? false);
  const guard = new AccessGuard(
    new Reflector(),
    requestContext,
    { find } as unknown as MembershipLookupRepository,
    { isPlatformAdmin } as unknown as UsersRepository,
  );

  async function run(
    target: { prototype: object },
    method: string,
    request: Record<string, unknown>,
  ): Promise<{
    result: boolean | AppException;
    request: Record<string, unknown>;
    scope: ReturnType<RequestContext['get']>;
  }> {
    const handler = (target.prototype as Record<string, () => void>)[method]!;
    const context = {
      getType: () => 'http',
      getHandler: () => handler,
      getClass: () => target,
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
    let scope: ReturnType<RequestContext['get']> = {};
    try {
      const result = await requestContext.run({}, async () => {
        const allowed = await guard.canActivate(context);
        scope = { ...requestContext.get() };
        return allowed;
      });
      return { result, request, scope };
    } catch (error) {
      if (error instanceof AppException) return { result: error, request, scope };
      throw error;
    }
  }
  return { run, find, isPlatformAdmin, requestContext };
}

const signedIn = (params: Record<string, string> = {}) => ({
  auth: { userId: USER, sessionId: 's-1' },
  params,
});

describe('AccessGuard', () => {
  it('lets public routes through without a session', async () => {
    const { run, find } = setup();
    expect((await run(Handlers, 'open', { params: {} })).result).toBe(true);
    expect(find).not.toHaveBeenCalled();
  });

  it('rejects a route that was reached without authentication (wiring error) with 401', async () => {
    const { run } = setup();
    const { result } = await run(Handlers, 'listUsers', { params: { organisationId: ORG } });
    expect(result).toBeInstanceOf(AppException);
    expect((result as AppException).getStatus()).toBe(401);
  });

  it('accepts any signed-in user on @Authenticated routes, also when declared on the class', async () => {
    const { run, find } = setup();
    expect((await run(Handlers, 'signedIn', signedIn())).result).toBe(true);
    expect((await run(ClassLevel, 'anything', signedIn())).result).toBe(true);
    expect(find).not.toHaveBeenCalled();
  });

  it('denies a handler with no access declaration (deny by default)', async () => {
    const { run } = setup();
    const { result } = await run(Handlers, 'undeclared', signedIn({ organisationId: ORG }));
    expect((result as AppException).getStatus()).toBe(403);
  });

  describe('organisation routes', () => {
    it('admits an active member whose role holds the permission, and records the verified tenant', async () => {
      const { run } = setup({ membership: summary('COMPANY_ADMIN') });
      const { result, request, scope } = await run(
        Handlers,
        'listUsers',
        signedIn({ organisationId: ORG }),
      );
      expect(result).toBe(true);
      expect(scope).toMatchObject({
        organisationId: ORG,
        membershipId: 'm-1',
        role: 'COMPANY_ADMIN',
      });
      expect((request as { membership?: MembershipSummary }).membership?.role).toBe(
        'COMPANY_ADMIN',
      );
    });

    it('answers 403 when the role lacks the permission, without touching the request scope', async () => {
      const { run } = setup({ membership: summary('COMPANY_ADMIN') });
      const { result, request, scope } = await run(
        Handlers,
        'removeUser',
        signedIn({ organisationId: ORG }),
      );
      expect((result as AppException).getStatus()).toBe(403);
      expect(request).not.toHaveProperty('membership');
      expect(scope).toEqual({});
    });

    it.each([
      ['a non-member', null],
      ['a deactivated member', summary('COMPANY_OWNER', 'DEACTIVATED')],
    ])(
      'answers 404 for %s, never confirming the organisation exists',
      async (_label, membership) => {
        const { run } = setup({ membership });
        const { result } = await run(Handlers, 'listUsers', signedIn({ organisationId: ORG }));
        expect((result as AppException).getStatus()).toBe(404);
      },
    );

    it.each([undefined, 'not-a-uuid', '../../etc', ORG.toUpperCase().slice(1)])(
      'answers 404 for a malformed organisation id (%s) without a database call',
      async (organisationId) => {
        const { run, find } = setup({ membership: summary('COMPANY_OWNER') });
        const { result } = await run(
          Handlers,
          'listUsers',
          signedIn(organisationId === undefined ? {} : { organisationId }),
        );
        expect((result as AppException).getStatus()).toBe(404);
        expect(find).not.toHaveBeenCalled();
      },
    );

    it('admits every active role on a member-only route', async () => {
      for (const role of [
        'COMPANY_OWNER',
        'COMPANY_ADMIN',
        'COMPLIANCE_MANAGER',
        'COURSE_ADMINISTRATOR',
        'STANDARD_USER',
        'READ_ONLY',
      ] as const) {
        const { run } = setup({ membership: summary(role) });
        expect((await run(Handlers, 'mine', signedIn({ organisationId: ORG }))).result).toBe(true);
      }
    });
  });

  describe('platform routes', () => {
    it('admits a platform administrator and needs no organisation', async () => {
      const { run, find } = setup({ platformAdmin: true });
      expect((await run(Handlers, 'provision', signedIn())).result).toBe(true);
      expect(find).not.toHaveBeenCalled();
    });

    it('answers 403 for everyone else', async () => {
      const { run } = setup({ platformAdmin: false });
      const { result } = await run(Handlers, 'provision', signedIn());
      expect((result as AppException).getStatus()).toBe(403);
    });

    it('does not let a platform administrator into an organisation they do not belong to', async () => {
      const { run } = setup({ platformAdmin: true, membership: null });
      const { result } = await run(Handlers, 'listUsers', signedIn({ organisationId: ORG }));
      expect((result as AppException).getStatus()).toBe(404);
    });
  });
});
