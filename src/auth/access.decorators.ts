import { applyDecorators, SetMetadata } from '@nestjs/common';
import { ApiExtension } from '@nestjs/swagger';
import type { Permission, PlatformPermission } from '../permissions/catalogue.js';

export const IS_PUBLIC_KEY = 'fca:access:public';
export const AUTHENTICATED_KEY = 'fca:access:authenticated';
export const REQUIRE_PERMISSION_KEY = 'fca:access:permission';
export const ORGANISATION_MEMBER_KEY = 'fca:access:organisation-member';
export const PLATFORM_ONLY_KEY = 'fca:access:platform-only';

/**
 * Every handler declares exactly one of the five decorators below; the global guards are deny by
 * default and a test (`test/access-declaration.e2e-spec.ts`) fails for a handler with none. Each
 * also writes `x-access` (and `x-permission` where there is one) into the OpenAPI document, so the
 * contract states who may call what.
 */

/**
 * Explicit opt-out of authentication (health, meta, the auth bootstrap endpoints). Everything not
 * marked public requires a valid access token.
 */
export const Public = () =>
  applyDecorators(SetMetadata(IS_PUBLIC_KEY, true), ApiExtension('x-access', 'public'));

/**
 * Any signed-in user, not tied to an organisation (`/me`, the organisation list, accepting an
 * invitation). Routes inside an organisation use `@RequirePermission` or `@OrganisationMember`.
 */
export const Authenticated = () =>
  applyDecorators(SetMetadata(AUTHENTICATED_KEY, true), ApiExtension('x-access', 'authenticated'));

/**
 * An organisation route that needs a permission from the catalogue. The caller must be an ACTIVE
 * member of `:organisationId` (otherwise 404) and their role must hold the permission (otherwise 403,
 * decided before anything is looked up).
 */
export const RequirePermission = (permission: Permission) =>
  applyDecorators(
    SetMetadata(REQUIRE_PERMISSION_KEY, permission),
    ApiExtension('x-access', 'permission'),
    ApiExtension('x-permission', permission),
  );

/** An organisation route open to every ACTIVE member whatever their role (their own membership, notifications). */
export const OrganisationMember = () =>
  applyDecorators(
    SetMetadata(ORGANISATION_MEMBER_KEY, true),
    ApiExtension('x-access', 'organisation-member'),
  );

/**
 * A `/platform/*` route: only a user with the platform-admin flag (ADR-0005). Such a user gets no
 * access to any organisation's data through it.
 */
export const PlatformOnly = (permission: PlatformPermission) =>
  applyDecorators(
    SetMetadata(PLATFORM_ONLY_KEY, permission),
    ApiExtension('x-access', 'platform'),
    ApiExtension('x-permission', permission),
  );

/** Every metadata key that counts as "this handler declared how it is protected" (checked by a test). */
export const ACCESS_METADATA_KEYS: readonly string[] = [
  IS_PUBLIC_KEY,
  AUTHENTICATED_KEY,
  REQUIRE_PERMISSION_KEY,
  ORGANISATION_MEMBER_KEY,
  PLATFORM_ONLY_KEY,
];
