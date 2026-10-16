/**
 * The typed catalogue of security events (events that belong to no organisation). Add an entry
 * together with the code that writes it. Tenant events use `AuditService` and `audit_events`.
 */
export const SECURITY_EVENT_TYPES = [
  'auth.registered',
  'auth.registration_ignored_existing',
  'auth.email_verified',
  'auth.verification_resent',
  'auth.login_succeeded',
  'auth.login_failed',
  'auth.login_locked',
  'auth.login_unverified',
  'auth.session_refreshed',
  'auth.refresh_reuse_detected',
  'auth.logout',
  'auth.password_reset_requested',
  'auth.password_reset_completed',
  'platform_admin.granted',
  'platform_admin.revoked',
] as const;

export type SecurityEventType = (typeof SECURITY_EVENT_TYPES)[number];
