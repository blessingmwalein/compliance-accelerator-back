/**
 * The typed permission catalogue and the six role bundles (ADR-0005, docs/rbac-matrix.md).
 *
 * A permission is `<module>.<action>`. Handlers reference a key with `@RequirePermission('x.y')` (a
 * typo is a compile error); a role is a named bundle of keys. The role bundles below are the single
 * source of truth: the OpenAPI document (`x-permission`), the `/organisations/:id/me` response, the
 * generated RBAC test matrix and `docs/rbac-matrix.md` (checked by a test) all derive from them.
 * Nothing here is a runtime database table: the six roles are fixed in v1.
 */

export const ROLES = [
  'COMPANY_OWNER',
  'COMPANY_ADMIN',
  'COMPLIANCE_MANAGER',
  'COURSE_ADMINISTRATOR',
  'STANDARD_USER',
  'READ_ONLY',
] as const;
export type Role = (typeof ROLES)[number];

/** Short column labels used by docs/rbac-matrix.md (same order as `ROLES`). */
export const ROLE_COLUMN: Readonly<Record<Role, string>> = {
  COMPANY_OWNER: 'OWN',
  COMPANY_ADMIN: 'ADM',
  COMPLIANCE_MANAGER: 'CMG',
  COURSE_ADMINISTRATOR: 'CRS',
  STANDARD_USER: 'STD',
  READ_ONLY: 'RO',
};

export const ROLE_LABEL: Readonly<Record<Role, string>> = {
  COMPANY_OWNER: 'Company Owner',
  COMPANY_ADMIN: 'Company Admin',
  COMPLIANCE_MANAGER: 'Compliance Manager',
  COURSE_ADMINISTRATOR: 'Course Administrator',
  STANDARD_USER: 'Standard User',
  READ_ONLY: 'Read Only',
};

const [OWN, ADM, CMG, CRS, STD, RO] = ROLES;

/**
 * Every permission with the roles that hold it. Rows follow docs/rbac-matrix.md; keys marked
 * "addition" there are new relative to the legacy matrix and await the owner's review.
 */
const GRANTS = {
  // --- inherited from the legacy matrix ---
  'governance.view': [OWN, ADM, CMG, STD, RO],
  'governance.create': [OWN, ADM, CMG],
  'governance.edit': [OWN, ADM, CMG],
  'governance.delete': [OWN, ADM],
  'data.create': [OWN, ADM, CMG, STD],
  'data.edit': [OWN, ADM, CMG, STD],
  'data.delete': [OWN, ADM, CMG],
  'data.export': [OWN, ADM, CMG],
  'training.view': [OWN, ADM, CMG, CRS, STD, RO],
  'training.create': [OWN, ADM, CRS],
  'training.edit': [OWN, ADM, CRS],
  'training.delete': [OWN, ADM, CRS],
  'training.assign': [OWN, ADM, CRS],
  'users.view': [OWN, ADM],
  'users.create': [OWN, ADM],
  'users.edit': [OWN, ADM],
  'users.delete': [OWN],
  'company.view': [OWN, ADM, CMG, STD, RO],
  'company.edit': [OWN, ADM],
  'company.branding': [OWN],
  'reports.view': [OWN, ADM, CMG, RO],
  'reports.export': [OWN, ADM, CMG],
  // --- additions (rbac-matrix.md section 2) ---
  'dashboard.view': [OWN, ADM, CMG, STD, RO],
  'data.view': [OWN, ADM, CMG, STD, RO],
  'businessUnits.view': [OWN, ADM, CMG, STD, RO],
  'businessUnits.create': [OWN, ADM],
  'businessUnits.edit': [OWN, ADM],
  'businessUnits.delete': [OWN, ADM],
  'mapping.view': [OWN, ADM, CMG, STD, RO],
  'mapping.edit': [OWN, ADM, CMG],
  'mapping.loadDefaults': [OWN, ADM, CMG],
  'governance.approve': [OWN, ADM, CMG],
  'remediation.updateOwn': [OWN, ADM, CMG, STD],
  'audit.view': [OWN, ADM, CMG],
  'audit.export': [OWN, ADM, CMG],
  'reminders.view': [OWN, ADM, CMG, STD, RO],
  'reminders.manage': [OWN, ADM, CMG],
  'notifications.own': [OWN, ADM, CMG, CRS, STD, RO],
  'subscription.view': [OWN, ADM],
  'subscription.manage': [OWN],
  'ai.run': [OWN, ADM, CMG],
  'training.take': [OWN, ADM, CMG, CRS, STD, RO],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof GRANTS;

/** Every permission key, in the order of the matrix. */
export const PERMISSIONS = Object.keys(GRANTS) as readonly Permission[];

/** Platform-scope permissions: held by the platform-admin flag, never by an organisation role (ADR-0005). */
export const PLATFORM_PERMISSIONS = [
  'platform.organisations.manage',
  'platform.plans.manage',
] as const;
export type PlatformPermission = (typeof PLATFORM_PERMISSIONS)[number];

const bundleOf = (role: Role): ReadonlySet<Permission> =>
  new Set(
    PERMISSIONS.filter((permission) => (GRANTS[permission] as readonly Role[]).includes(role)),
  );

const BUNDLES: Readonly<Record<Role, ReadonlySet<Permission>>> = {
  COMPANY_OWNER: bundleOf('COMPANY_OWNER'),
  COMPANY_ADMIN: bundleOf('COMPANY_ADMIN'),
  COMPLIANCE_MANAGER: bundleOf('COMPLIANCE_MANAGER'),
  COURSE_ADMINISTRATOR: bundleOf('COURSE_ADMINISTRATOR'),
  STANDARD_USER: bundleOf('STANDARD_USER'),
  READ_ONLY: bundleOf('READ_ONLY'),
};

export function isPermission(value: string): value is Permission {
  return Object.hasOwn(GRANTS, value);
}

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

export function roleHas(role: Role, permission: Permission): boolean {
  return BUNDLES[role].has(permission);
}

/** The permissions of a role, sorted: stable for responses and snapshots. */
export function permissionsOf(role: Role): Permission[] {
  return [...BUNDLES[role]].sort();
}

/** The roles that hold a permission (for the generated matrices and the documentation check). */
export function rolesWith(permission: Permission): readonly Role[] {
  return GRANTS[permission];
}

/**
 * Role-assignment rules that sit beside the permission check (docs/rbac-matrix.md, AC-USR-04):
 * only an Owner may grant, change or remove the Owner role.
 */
export function mayAssignRole(actor: Role, target: Role): boolean {
  return target !== 'COMPANY_OWNER' || actor === 'COMPANY_OWNER';
}
