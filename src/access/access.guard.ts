import { CanActivate, ExecutionContext, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import {
  AUTHENTICATED_KEY,
  IS_PUBLIC_KEY,
  ORGANISATION_MEMBER_KEY,
  PLATFORM_ONLY_KEY,
  REQUIRE_PERMISSION_KEY,
} from '../auth/access.decorators.js';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import { UsersRepository } from '../auth/users.repository.js';
import { AppException, ErrorCode } from '../common/errors/app.exception.js';
import { roleHas, type Permission } from '../permissions/catalogue.js';
import { RequestContext } from '../tenancy/request-context.js';
import { MembershipLookupRepository } from './membership-lookup.repository.js';
import type { OrganisationRequest } from './organisation-request.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const notFound = () =>
  new AppException(ErrorCode.NotFound, HttpStatus.NOT_FOUND, 'Resource not found.');
const forbidden = (detail: string) =>
  new AppException(ErrorCode.Forbidden, HttpStatus.FORBIDDEN, detail);

/**
 * Authorisation, run right after `AuthGuard` (ADR-0004/0005). It turns "this request carries a valid
 * session" into "this caller may do THIS here":
 *
 * - `@Public` and `@Authenticated` need nothing more.
 * - `@PlatformOnly`: the platform-admin flag, re-read from the database on every request.
 * - `@RequirePermission` / `@OrganisationMember`: the caller must be an ACTIVE member of the
 *   organisation in the path. A non-member, a deactivated member and an unknown organisation all get
 *   the same 404 (the API never confirms that an organisation exists). A member whose role lacks the
 *   permission gets 403 BEFORE any record is looked up. Only then are organisation, membership and role
 *   written to the request scope, so tenant code can never run for an unverified organisation.
 * - A handler with no declaration is DENIED (403), not allowed.
 *
 * Roles and membership are read from the database on every request, never from the token, so a role
 * change or deactivation applies at once. Denials are logged, not stored: an audit row per 403 would
 * let any member flood the append-only trail.
 */
@Injectable()
export class AccessGuard implements CanActivate {
  private readonly logger = new Logger(AccessGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly requestContext: RequestContext,
    private readonly memberships: MembershipLookupRepository,
    private readonly users: UsersRepository,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const targets = [context.getHandler(), context.getClass()];
    const read = <T>(key: string) => this.reflector.getAllAndOverride<T | undefined>(key, targets);

    if (read<boolean>(IS_PUBLIC_KEY)) return true;

    const request = context
      .switchToHttp()
      .getRequest<Request & Partial<AuthenticatedRequest> & Partial<OrganisationRequest>>();
    const auth = request.auth;
    if (!auth) {
      // AuthGuard runs first and always sets this: reaching here without it is a wiring error.
      throw new AppException(
        ErrorCode.Unauthenticated,
        HttpStatus.UNAUTHORIZED,
        'Authentication required.',
      );
    }

    if (read<boolean>(AUTHENTICATED_KEY)) return true;

    if (read<string>(PLATFORM_ONLY_KEY)) {
      if (!(await this.users.isPlatformAdmin(auth.userId))) {
        this.logger.warn(`platform route denied user=${auth.userId}`);
        throw forbidden('Platform administrator access is required.');
      }
      return true;
    }

    const permission = read<Permission>(REQUIRE_PERMISSION_KEY);
    const memberOnly = read<boolean>(ORGANISATION_MEMBER_KEY);
    if (!permission && !memberOnly) {
      this.logger.error(
        `no access declaration on ${context.getClass().name}.${context.getHandler().name}: denied`,
      );
      throw forbidden('This route has no access declaration.');
    }

    const organisationId = request.params?.organisationId;
    if (typeof organisationId !== 'string' || !UUID.test(organisationId)) throw notFound();

    const membership = await this.memberships.find(auth.userId, organisationId);
    if (!membership || membership.status !== 'ACTIVE') throw notFound();

    if (permission && !roleHas(membership.role, permission)) {
      this.logger.warn(
        `permission denied user=${auth.userId} org=${organisationId} role=${membership.role} permission=${permission}`,
      );
      throw forbidden('Your role does not allow this action.');
    }

    request.membership = membership;
    this.requestContext.update({
      organisationId,
      membershipId: membership.membershipId,
      role: membership.role,
    });
    return true;
  }
}
