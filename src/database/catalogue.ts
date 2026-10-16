/**
 * The tenancy catalogue: which tables are tenant-owned, global, or the tenant root. A test
 * (`catalogue.spec.ts`) parses `prisma/schema.prisma` and fails the build when this file and the
 * schema disagree, so a new table cannot silently skip tenant scoping.
 */

/**
 * Prisma model names of tenant-owned tables: every one has a non-null `organisation_id` and is
 * queried only through the tenant safety net (`tenant-guard.ts`).
 */
export const TENANT_MODELS = [
  'Membership',
  'Invitation',
  'AuditEvent',
  'IdempotencyKey',
  'RegulatorContact',
  'BusinessUnit',
  'OrganisationFramework',
  'OrganisationEntitlement',
  'GovernanceArea',
  'OrganisationMapping',
  'Assessment',
  'AssessmentItem',
  'ItemPriority',
  'AssessmentPolicy',
  'RemediationTask',
  'RemediationTaskEvent',
  'Evidence',
  'AssessmentItemEvidence',
  'RemediationTaskEvidence',
  'Report',
] as const;
export type TenantModelName = (typeof TENANT_MODELS)[number];

/**
 * Tables with no `organisation_id` that are deliberately NOT tenant-owned, each with the reason.
 * Adding a table here is a security decision: say why it cannot hold one tenant's data.
 */
export const GLOBAL_TABLES = {
  users: 'A person can belong to several organisations; access is granted through memberships.',
  sessions:
    'A login belongs to a user, not to an organisation; membership is re-read on every request.',
  refresh_tokens: 'Belongs to a session (a user).',
  auth_tokens: 'Email-verification and password-reset tokens belong to a user.',
  login_attempts:
    'Lockout counters are keyed on hashed account and client IP, before any organisation is known.',
  security_events:
    'Events with no organisation (registration, login, refresh reuse); tenant events go to audit_events.',
  jobs: 'System work queue. Tenant jobs carry organisationId in the payload and their handler re-checks it.',
  frameworks:
    'Reference catalogue of frameworks shared by every organisation: identifiers only (code, name, jurisdiction), no tenant data and no legal text.',
  plans:
    'Subscription plans are platform-managed reference data; what an organisation is entitled to is its own snapshot in organisation_entitlements.',
  framework_versions:
    'One edition of a framework (provenance, status, hashes): global reference data written only by the owner-run loader, readable by every organisation.',
  requirements:
    'The tree of a framework version (identifiers, titles): global reference data of a frozen version, no tenant data.',
  mapping_pack_entries:
    'Default cross-framework mappings from a cited crosswalk or named reviewer: global reference data; an organisation gets its own copy in organisation_mappings.',
  email_deliveries:
    'Keyed on the recipient ADDRESS (invitees and DPO contacts need not be users); no tenant data.',
} as const satisfies Record<string, string>;

/** The tenant root: its own `id` IS the tenant id, so it has no `organisation_id` column. */
export const TENANT_ROOT_TABLES = ['organisations'] as const;
