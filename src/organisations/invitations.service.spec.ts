import { describe, expect, it } from 'vitest';
import { AppException } from '../common/errors/app.exception.js';
import { createOrgWorld } from '../../test/support/org-world.js';
import { INVITATION_SEND_WINDOW_MS, INVITATION_TTL_MS } from './invitation-jobs.js';

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
  return { ...w, owner, admin };
}

describe('InvitationsService.create', () => {
  it('stores a pending invitation, queues one email job with ids only, and audits it', async () => {
    const w = world();
    w.actAs(w.admin);
    const result = await w.invites.create({ email: 'new@acme.test', role: 'STANDARD_USER' });

    expect(result).toMatchObject({
      email: 'new@acme.test',
      role: 'STANDARD_USER',
      state: 'PENDING',
      sendCount: 0,
      invitedByName: 'admin',
    });
    expect(new Date(result.expiresAt).getTime()).toBe(w.clock.now().getTime() + INVITATION_TTL_MS);
    expect(w.jobs).toHaveLength(1);
    expect(w.jobs[0]!.type).toBe('invitations.send');
    expect(Object.keys(w.jobs[0]!.payload).sort()).toEqual(['invitationId', 'organisationId']);
    expect(JSON.stringify(w.jobs[0])).not.toContain('new@acme.test');
    expect(w.audits.map((a) => a.action)).toEqual(['invitation.created']);
  });

  it('only an owner may invite an owner', async () => {
    const w = world();
    w.actAs(w.admin);
    const error = await failure(
      w.invites.create({ email: 'boss@acme.test', role: 'COMPANY_OWNER' }),
    );
    expect(error.code).toBe('OWNER_ONLY');
    expect(w.invitations).toHaveLength(0);

    w.actAs(w.owner);
    await w.invites.create({ email: 'boss@acme.test', role: 'COMPANY_OWNER' });
    expect(w.invitations).toHaveLength(1);
  });

  it('refuses an address that is already an active member', async () => {
    const w = world();
    w.actAs(w.admin);
    const error = await failure(w.invites.create({ email: 'owner@acme.test', role: 'READ_ONLY' }));
    expect(error.code).toBe('ALREADY_MEMBER');
  });

  it('accepts an address whose membership was deactivated (it rejoins on acceptance)', async () => {
    const w = world();
    w.addMember('former@acme.test', 'STANDARD_USER', 'DEACTIVATED');
    w.actAs(w.admin);
    const result = await w.invites.create({ email: 'former@acme.test', role: 'READ_ONLY' });
    expect(result.state).toBe('PENDING');
  });

  it('refuses a second pending invitation for the same address', async () => {
    const w = world();
    w.actAs(w.admin);
    await w.invites.create({ email: 'new@acme.test', role: 'READ_ONLY' });
    const error = await failure(
      w.invites.create({ email: 'new@acme.test', role: 'STANDARD_USER' }),
    );
    expect(error.code).toBe('INVITATION_PENDING');
    expect(error.getStatus()).toBe(409);
  });

  it('replaces an EXPIRED pending invitation instead of blocking the address', async () => {
    const w = world();
    w.actAs(w.admin);
    const first = await w.invites.create({ email: 'new@acme.test', role: 'READ_ONLY' });
    w.clock.advance(INVITATION_TTL_MS / 1000 + 60);
    const second = await w.invites.create({ email: 'new@acme.test', role: 'STANDARD_USER' });

    expect(second.id).not.toBe(first.id);
    expect(w.invitations.find((i) => i.id === first.id)!.status).toBe('REVOKED');
    expect(w.audits.map((a) => a.action)).toEqual([
      'invitation.created',
      'invitation.revoked',
      'invitation.created',
    ]);
  });

  it('maps a unique-index race (two concurrent creates) to INVITATION_PENDING', async () => {
    const w = world();
    w.actAs(w.admin);
    w.failNext.code = 'P2002';
    const error = await failure(w.invites.create({ email: 'new@acme.test', role: 'READ_ONLY' }));
    expect(error.code).toBe('INVITATION_PENDING');
  });
});

describe('InvitationsService.resend and revoke', () => {
  it('one email per window: creating and resending at once queues a single job', async () => {
    const w = world();
    w.actAs(w.admin);
    const invitation = await w.invites.create({ email: 'new@acme.test', role: 'READ_ONLY' });
    await w.invites.resend(invitation.id);
    expect(w.jobs).toHaveLength(1);
    expect(w.audits.map((a) => a.action)).toEqual(['invitation.created']);

    w.clock.advance(INVITATION_SEND_WINDOW_MS / 1000 + 1);
    await w.invites.resend(invitation.id);
    expect(w.jobs).toHaveLength(2);
    expect(w.audits.map((a) => a.action)).toEqual(['invitation.created', 'invitation.resent']);
  });

  it('cannot resend or revoke what does not exist, and cannot resend a revoked invitation', async () => {
    const w = world();
    w.actAs(w.admin);
    expect(
      (await failure(w.invites.resend('0198a0f6-7c2e-7a53-9b1e-ffffffffffff'))).getStatus(),
    ).toBe(404);
    expect(
      (await failure(w.invites.revoke('0198a0f6-7c2e-7a53-9b1e-ffffffffffff'))).getStatus(),
    ).toBe(404);
    const invitation = await w.invites.create({ email: 'new@acme.test', role: 'READ_ONLY' });
    await w.invites.revoke(invitation.id);
    expect((await failure(w.invites.resend(invitation.id))).getStatus()).toBe(409);
  });

  it('revoking is idempotent; an accepted invitation cannot be revoked', async () => {
    const w = world();
    w.actAs(w.admin);
    const invitation = await w.invites.create({ email: 'new@acme.test', role: 'READ_ONLY' });
    const revoked = await w.invites.revoke(invitation.id);
    expect(revoked.state).toBe('REVOKED');
    await w.invites.revoke(invitation.id);
    expect(w.audits.filter((a) => a.action === 'invitation.revoked')).toHaveLength(1);

    const other = await w.invites.create({ email: 'other@acme.test', role: 'READ_ONLY' });
    w.invitations.find((i) => i.id === other.id)!.status = 'ACCEPTED';
    expect((await failure(w.invites.revoke(other.id))).getStatus()).toBe(409);
  });

  it('reports an expired pending invitation as EXPIRED without storing it', async () => {
    const w = world();
    w.actAs(w.admin);
    await w.invites.create({ email: 'new@acme.test', role: 'READ_ONLY' });
    w.clock.advance(INVITATION_TTL_MS / 1000 + 1);
    const page = await w.invites.list({});
    expect(page.items[0]!.state).toBe('EXPIRED');
    expect(w.invitations[0]!.status).toBe('PENDING');
  });
});

describe('InvitationsService.inspect and accept', () => {
  async function invited(
    role: 'READ_ONLY' | 'COMPANY_OWNER' = 'READ_ONLY',
    email = 'new@acme.test',
  ) {
    const w = world();
    w.actAs(w.owner);
    const invitation = await w.invites.create({ email, role });
    const token = w.sendToken(invitation.id);
    return { ...w, invitation, token };
  }

  it('inspect shows the organisation and role for a usable token only', async () => {
    const w = await invited();
    expect(await w.invites.inspect(w.token)).toMatchObject({
      organisationName: 'Acme Ltd',
      role: 'READ_ONLY',
    });
    expect((await failure(w.invites.inspect('x'.repeat(43)))).code).toBe('INVALID_TOKEN');
    w.clock.advance(INVITATION_TTL_MS / 1000 + 1);
    expect((await failure(w.invites.inspect(w.token))).code).toBe('INVALID_TOKEN');
  });

  it('accept creates the membership with the invited role and audits both events', async () => {
    const w = await invited('COMPANY_OWNER');
    const invitee = w.addUser('new@acme.test');
    const result = await w.invites.accept(invitee.id, w.token);

    expect(result).toEqual({
      organisationId: '0198a0f6-7c2e-7a53-9b1e-0000000000a1',
      role: 'COMPANY_OWNER',
    });
    expect(w.memberships.find((m) => m.userId === invitee.id)).toMatchObject({
      role: 'COMPANY_OWNER',
      status: 'ACTIVE',
    });
    expect(w.invitations[0]!.status).toBe('ACCEPTED');
    expect(w.audits.map((a) => a.action)).toEqual([
      'invitation.created',
      'membership.created',
      'invitation.accepted',
    ]);
  });

  it('the link works exactly once', async () => {
    const w = await invited();
    const invitee = w.addUser('new@acme.test');
    await w.invites.accept(invitee.id, w.token);
    expect((await failure(w.invites.accept(invitee.id, w.token))).code).toBe('INVALID_TOKEN');
  });

  it('refuses an account whose email differs from the invited address (without revealing it)', async () => {
    const w = await invited();
    const other = w.addUser('someone-else@acme.test');
    const error = await failure(w.invites.accept(other.id, w.token));
    expect(error.code).toBe('INVITATION_EMAIL_MISMATCH');
    expect(error.getStatus()).toBe(403);
    expect(JSON.stringify(error.getResponse())).not.toContain('new@acme.test');
    expect(w.memberships.some((m) => m.userId === other.id)).toBe(false);
    expect(w.invitations[0]!.status).toBe('PENDING');
  });

  it('refuses an account that has not confirmed its email address', async () => {
    const w = await invited();
    const invitee = w.addUser('new@acme.test', { verified: false });
    expect((await failure(w.invites.accept(invitee.id, w.token))).code).toBe('EMAIL_NOT_VERIFIED');
  });

  it('refuses an expired, revoked or replaced token with the same uniform error', async () => {
    const w = await invited();
    const invitee = w.addUser('new@acme.test');
    await w.invites.revoke(w.invitation.id);
    expect((await failure(w.invites.accept(invitee.id, w.token))).code).toBe('INVALID_TOKEN');

    const fresh = await invited();
    const freshInvitee = fresh.addUser('new@acme.test');
    fresh.clock.advance(INVITATION_TTL_MS / 1000 + 1);
    expect((await failure(fresh.invites.accept(freshInvitee.id, fresh.token))).code).toBe(
      'INVALID_TOKEN',
    );
  });

  it('reactivates a deactivated member with the invited role', async () => {
    const w = world();
    const former = w.addMember('former@acme.test', 'STANDARD_USER', 'DEACTIVATED');
    w.actAs(w.owner);
    const invitation = await w.invites.create({
      email: 'former@acme.test',
      role: 'COMPLIANCE_MANAGER',
    });
    const token = w.sendToken(invitation.id);
    await w.invites.accept(former.userId, token);
    expect(former).toMatchObject({ status: 'ACTIVE', role: 'COMPLIANCE_MANAGER' });
    expect(w.memberships.filter((m) => m.userId === former.userId)).toHaveLength(1);
  });

  it('a member who is already active gets ALREADY_MEMBER', async () => {
    const w = await invited();
    const invitee = w.addMember('new@acme.test', 'STANDARD_USER');
    const error = await failure(w.invites.accept(invitee.userId, w.token));
    expect(error.code).toBe('ALREADY_MEMBER');
  });
});
