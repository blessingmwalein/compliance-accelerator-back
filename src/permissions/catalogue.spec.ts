import { describe, expect, it } from 'vitest';
import {
  PERMISSIONS,
  ROLES,
  isPermission,
  isRole,
  mayAssignRole,
  permissionsOf,
  roleHas,
  rolesWith,
} from './catalogue.js';

describe('permission catalogue', () => {
  it('has unique <module>.<action> keys', () => {
    expect(new Set(PERMISSIONS).size).toBe(PERMISSIONS.length);
    for (const key of PERMISSIONS) expect(key).toMatch(/^[a-z][A-Za-z]*\.[a-z][A-Za-z]*$/);
  });

  it('gives the Company Owner every permission', () => {
    expect(permissionsOf('COMPANY_OWNER')).toHaveLength(PERMISSIONS.length);
  });

  it('keeps the legacy semantics that the owner chose', () => {
    // legacy PermissionGuard: Admin = everything except users.delete and company.branding
    const adminLacks = PERMISSIONS.filter((p) => !roleHas('COMPANY_ADMIN', p));
    expect(adminLacks.sort()).toEqual(['company.branding', 'subscription.manage', 'users.delete']);
    // Course Administrator: training only (plus own notifications)
    expect(permissionsOf('COURSE_ADMINISTRATOR')).toEqual([
      'notifications.own',
      'training.assign',
      'training.create',
      'training.delete',
      'training.edit',
      'training.take',
      'training.view',
    ]);
    // Read Only never creates, edits, deletes, exports, approves or manages anything
    for (const permission of permissionsOf('READ_ONLY')) {
      expect(permission).toMatch(/\.(view|own|take)$/);
    }
  });

  it('only an Owner manages the Owner role and removes members', () => {
    expect(rolesWith('users.delete')).toEqual(['COMPANY_OWNER']);
    expect(mayAssignRole('COMPANY_OWNER', 'COMPANY_OWNER')).toBe(true);
    expect(mayAssignRole('COMPANY_ADMIN', 'COMPANY_OWNER')).toBe(false);
    expect(mayAssignRole('COMPANY_ADMIN', 'COMPANY_ADMIN')).toBe(true);
    expect(mayAssignRole('COMPANY_ADMIN', 'READ_ONLY')).toBe(true);
  });

  it('answers membership questions strictly (unknown strings are not permissions or roles)', () => {
    expect(isPermission('users.view')).toBe(true);
    expect(isPermission('users.view ')).toBe(false);
    expect(isPermission('constructor')).toBe(false);
    expect(isPermission('__proto__')).toBe(false);
    expect(isRole('READ_ONLY')).toBe(true);
    expect(isRole('ADMIN')).toBe(false);
    expect(ROLES).toHaveLength(6);
  });

  it('returns sorted, copied lists so callers cannot change a bundle', () => {
    const list = permissionsOf('STANDARD_USER');
    expect([...list].sort()).toEqual(list);
    list.pop();
    expect(permissionsOf('STANDARD_USER').length).toBeGreaterThan(list.length);
  });
});
