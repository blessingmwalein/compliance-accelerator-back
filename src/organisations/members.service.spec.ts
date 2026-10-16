import { describe, expect, it } from 'vitest';
import { AppException } from '../common/errors/app.exception.js';
import { createOrgWorld } from '../../test/support/org-world.js';

/** Resolves to the AppException a call throws (fails the test when it does not throw). */
async function failure(call: Promise<unknown>): Promise<AppException> {
  try {
    await call;
  } catch (error) {
    if (error instanceof AppException) return error;
    throw error;
  }
  throw new Error('expected the call to fail');
}

function world() {
  const w = createOrgWorld();
  const owner = w.addMember('owner@acme.test', 'COMPANY_OWNER');
  const admin = w.addMember('admin@acme.test', 'COMPANY_ADMIN');
  const staff = w.addMember('staff@acme.test', 'STANDARD_USER');
  return { ...w, owner, admin, staff };
}

describe('MembersService.changeRole', () => {
  it('lets an admin change a standard user, bumps the version and audits from/to', async () => {
    const w = world();
    w.actAs(w.admin);
    const result = await w.members.changeRole(w.staff.id, { role: 'READ_ONLY', version: 1 });
    expect(result).toMatchObject({ id: w.staff.id, role: 'READ_ONLY', version: 2 });
    expect(w.audits).toEqual([
      expect.objectContaining({
        action: 'membership.role_changed',
        entityId: w.staff.id,
        changes: { role: { from: 'STANDARD_USER', to: 'READ_ONLY' } },
      }),
    ]);
  });

  it('only an owner may grant the Owner role', async () => {
    const w = world();
    w.actAs(w.admin);
    const error = await failure(
      w.members.changeRole(w.staff.id, { role: 'COMPANY_OWNER', version: 1 }),
    );
    expect(error.code).toBe('OWNER_ONLY');
    expect(error.getStatus()).toBe(403);
    expect(w.staff.role).toBe('STANDARD_USER');
    expect(w.audits).toHaveLength(0);

    w.actAs(w.owner);
    await w.members.changeRole(w.staff.id, { role: 'COMPANY_OWNER', version: 1 });
    expect(w.staff.role).toBe('COMPANY_OWNER');
  });

  it('an admin cannot change an owner, even to a lower role', async () => {
    const w = world();
    w.actAs(w.admin);
    const error = await failure(
      w.members.changeRole(w.owner.id, { role: 'READ_ONLY', version: 1 }),
    );
    expect(error.code).toBe('OWNER_ONLY');
    expect(w.owner.role).toBe('COMPANY_OWNER');
  });

  it('nobody changes their own role', async () => {
    const w = world();
    w.actAs(w.owner);
    const error = await failure(
      w.members.changeRole(w.owner.id, { role: 'READ_ONLY', version: 1 }),
    );
    expect(error.code).toBe('SELF_CHANGE_NOT_ALLOWED');
    expect(w.owner.role).toBe('COMPANY_OWNER');
  });

  it('rejects a stale version with VERSION_CONFLICT and changes nothing', async () => {
    const w = world();
    w.actAs(w.admin);
    await w.members.changeRole(w.staff.id, { role: 'READ_ONLY', version: 1 });
    const error = await failure(
      w.members.changeRole(w.staff.id, { role: 'COMPLIANCE_MANAGER', version: 1 }),
    );
    expect(error.code).toBe('VERSION_CONFLICT');
    expect(error.getStatus()).toBe(409);
    expect(w.staff.role).toBe('READ_ONLY');
    expect(w.audits).toHaveLength(1);
  });

  it('is a no-op (no audit, no version bump) when the role is already the requested one', async () => {
    const w = world();
    w.actAs(w.admin);
    const result = await w.members.changeRole(w.staff.id, { role: 'STANDARD_USER', version: 1 });
    expect(result.version).toBe(1);
    expect(w.audits).toHaveLength(0);
  });

  it('refuses to change a deactivated member and a member that is not in the organisation', async () => {
    const w = world();
    const gone = w.addMember('gone@acme.test', 'STANDARD_USER', 'DEACTIVATED');
    w.actAs(w.admin);
    expect(
      (await failure(w.members.changeRole(gone.id, { role: 'READ_ONLY', version: 1 }))).getStatus(),
    ).toBe(409);
    expect(
      (
        await failure(
          w.members.changeRole('0198a0f6-7c2e-7a53-9b1e-ffffffffffff', {
            role: 'READ_ONLY',
            version: 1,
          }),
        )
      ).getStatus(),
    ).toBe(404);
  });

  it('keeps the last owner: demoting an owner fails when no other active owner remains after the lock', async () => {
    const w = world();
    const second = w.addMember('second@acme.test', 'COMPANY_OWNER');
    w.actAs(w.owner);
    // a concurrent request demoted the other owner first: after the lock only `second` is left
    w.lock.onlyOwners = [second.id];
    const error = await failure(
      w.members.changeRole(second.id, { role: 'COMPANY_ADMIN', version: 1 }),
    );
    expect(error.code).toBe('LAST_OWNER');
    expect(second.role).toBe('COMPANY_OWNER');
  });

  it('allows demoting an owner while another active owner remains', async () => {
    const w = world();
    const second = w.addMember('second@acme.test', 'COMPANY_OWNER');
    w.actAs(w.owner);
    const result = await w.members.changeRole(second.id, { role: 'COMPANY_ADMIN', version: 1 });
    expect(result.role).toBe('COMPANY_ADMIN');
  });
});

describe('MembersService.deactivate and reactivate', () => {
  it('deactivates a member, audits it, and is idempotent', async () => {
    const w = world();
    w.actAs(w.owner);
    const result = await w.members.deactivate(w.staff.id, { version: 1 });
    expect(result).toMatchObject({ status: 'DEACTIVATED', version: 2 });
    expect(w.audits.map((a) => a.action)).toEqual(['membership.deactivated']);

    const again = await w.members.deactivate(w.staff.id, { version: 1 });
    expect(again.status).toBe('DEACTIVATED');
    expect(w.audits).toHaveLength(1);
  });

  it('nobody deactivates themselves', async () => {
    const w = world();
    w.actAs(w.owner);
    expect((await failure(w.members.deactivate(w.owner.id, { version: 1 }))).code).toBe(
      'SELF_CHANGE_NOT_ALLOWED',
    );
  });

  it('never deactivates the last active owner', async () => {
    const w = world();
    const second = w.addMember('second@acme.test', 'COMPANY_OWNER');
    w.actAs(w.owner);
    w.lock.onlyOwners = [second.id];
    expect((await failure(w.members.deactivate(second.id, { version: 1 }))).code).toBe(
      'LAST_OWNER',
    );
    expect(second.status).toBe('ACTIVE');
  });

  it('rejects a stale version', async () => {
    const w = world();
    w.actAs(w.owner);
    expect((await failure(w.members.deactivate(w.staff.id, { version: 7 }))).code).toBe(
      'VERSION_CONFLICT',
    );
  });

  it('reactivates a deactivated member and audits it', async () => {
    const w = world();
    const gone = w.addMember('gone@acme.test', 'STANDARD_USER', 'DEACTIVATED');
    w.actAs(w.owner);
    const result = await w.members.reactivate(gone.id, { version: 1 });
    expect(result).toMatchObject({ status: 'ACTIVE', version: 2 });
    expect(w.audits.map((a) => a.action)).toEqual(['membership.reactivated']);
  });
});

describe('MembersService.list', () => {
  it('pages with a cursor and reports the next page', async () => {
    const w = world();
    w.actAs(w.owner);
    const first = await w.members.list({ limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBe(first.items[1]!.id);
    expect(first.items[0]).not.toHaveProperty('passwordHash');
  });
});
