import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { permissionsOf } from '../../src/permissions/catalogue.js';
import { createIntContext, type IntContext } from '../support/int-context.js';
import { readMails, resetMailDir } from '../support/mail.js';
import { as, createOrganisationWithAllRoles, createPerson } from '../support/people.js';

const MAIL_DIR = process.env.DEV_MAIL_DIR!;
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('organisations, members and invitations on a real database', () => {
  let ctx: IntContext;
  const tag = randomUUID().slice(0, 8);

  beforeAll(async () => {
    await resetMailDir(MAIL_DIR);
    ctx = await createIntContext();
  });
  afterAll(async () => {
    await ctx.close();
  });

  const mailsTo = async (email: string) =>
    (await readMails(MAIL_DIR)).filter((m) => m.to === email);

  it('creates an organisation (self-serve), makes the caller its Owner, and audits it', async () => {
    const founder = await createPerson(ctx, { label: `founder-${tag}` });

    const bad = await ctx
      .http()
      .post('/api/v1/organisations')
      .set(as(founder))
      .send({ name: 'Acme', timezone: 'Mars/Olympus' })
      .expect(400);
    expect(bad.body).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(bad.body.errors.map((e: { path: string }) => e.path)).toContain('timezone');

    const created = await ctx
      .http()
      .post('/api/v1/organisations')
      .set(as(founder))
      .send({ name: '  Acme Ltd  ', timezone: 'Africa/Harare' })
      .expect(201);
    expect(created.body).toMatchObject({
      name: 'Acme Ltd',
      timezone: 'Africa/Harare',
      role: 'COMPANY_OWNER',
    });
    const organisationId = created.body.id as string;
    expect(organisationId).toMatch(UUID_V7);

    const mine = await ctx.http().get('/api/v1/organisations').set(as(founder)).expect(200);
    expect(mine.body).toEqual([
      { id: organisationId, name: 'Acme Ltd', timezone: 'Africa/Harare', role: 'COMPANY_OWNER' },
    ]);

    const me = await ctx
      .http()
      .get(`/api/v1/organisations/${organisationId}/me`)
      .set(as(founder))
      .expect(200);
    expect(me.body.role).toBe('COMPANY_OWNER');
    expect(me.body.organisation).toEqual({
      id: organisationId,
      name: 'Acme Ltd',
      timezone: 'Africa/Harare',
    });
    expect(me.body.permissions).toEqual(permissionsOf('COMPANY_OWNER'));

    // persisted with the audit trail written in the same transaction, attributed to the founder
    const events = await ctx.admin.auditEvent.findMany({ where: { organisationId } });
    expect(events.map((e) => e.action).sort()).toEqual([
      'membership.created',
      'organisation.created',
    ]);
    expect(events.every((e) => e.actorUserId === founder.id && e.actorType === 'USER')).toBe(true);
    expect(
      await ctx.admin.membership.count({
        where: { organisationId, userId: founder.id, role: 'COMPANY_OWNER', status: 'ACTIVE' },
      }),
    ).toBe(1);
  });

  it('invitation: create, email, inspect, accept by the invited address only, exactly once', async () => {
    const { byRole, organisation } = await createOrganisationWithAllRoles(ctx, `inv-${tag}`);
    const admin = byRole.COMPANY_ADMIN;
    const inviteeEmail = `invitee-${tag}@example.test`;
    const base = `/api/v1/organisations/${organisation.id}`;

    // an admin cannot invite an Owner; an unknown shape is rejected before any work
    await ctx
      .http()
      .post(`${base}/invitations`)
      .set(as(admin))
      .send({ email: inviteeEmail, role: 'COMPANY_OWNER' })
      .expect(403);
    await ctx
      .http()
      .post(`${base}/invitations`)
      .set(as(admin))
      .send({ email: inviteeEmail, role: 'READ_ONLY', organisationId: organisation.id })
      .expect(400);

    const created = await ctx
      .http()
      .post(`${base}/invitations`)
      .set(as(admin))
      .send({ email: inviteeEmail.toUpperCase(), role: 'COMPLIANCE_MANAGER' })
      .expect(201);
    expect(created.body).toMatchObject({
      email: inviteeEmail,
      role: 'COMPLIANCE_MANAGER',
      state: 'PENDING',
      sendCount: 0,
    });
    expect(created.body).not.toHaveProperty('tokenHash');

    // a second pending invitation for the same address is refused
    const duplicate = await ctx
      .http()
      .post(`${base}/invitations`)
      .set(as(admin))
      .send({ email: inviteeEmail, role: 'READ_ONLY' })
      .expect(409);
    expect(duplicate.body.code).toBe('INVITATION_PENDING');

    // the email is sent by the job, with the token in the URL fragment and nothing secret at rest
    expect((await ctx.runner.runBatch({ limit: 20 })).succeeded).toBeGreaterThanOrEqual(1);
    const [mail] = await mailsTo(inviteeEmail);
    expect(mail).toBeDefined();
    expect(mail!.links[0]).toMatch(
      /^http:\/\/localhost:5173\/accept-invitation#token=[A-Za-z0-9_-]{43}$/,
    );
    expect(mail!.subject).toContain('invited');
    const stored = await ctx.admin.invitation.findUniqueOrThrow({ where: { id: created.body.id } });
    expect(stored.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.tokenHash).not.toBe(mail!.token);
    expect(stored.sendCount).toBe(1);
    const job = await ctx.admin.job.findFirstOrThrow({
      where: {
        type: 'invitations.send',
        payload: { path: ['invitationId'], equals: created.body.id },
      },
    });
    expect(JSON.stringify(job.payload)).not.toContain(inviteeEmail);

    const invitee = await createPerson(ctx, { email: inviteeEmail });
    const stranger = await createPerson(ctx, { label: `stranger-${tag}` });
    const token = mail!.token!;

    // the link shows what it offers, and only the invited address may accept
    const preview = await ctx
      .http()
      .post('/api/v1/invitations/inspect')
      .set(as(invitee))
      .send({ token })
      .expect(200);
    expect(preview.body).toMatchObject({
      organisationName: organisation.name,
      role: 'COMPLIANCE_MANAGER',
    });
    const mismatch = await ctx
      .http()
      .post('/api/v1/invitations/accept')
      .set(as(stranger))
      .send({ token })
      .expect(403);
    expect(mismatch.body.code).toBe('INVITATION_EMAIL_MISMATCH');
    expect(JSON.stringify(mismatch.body)).not.toContain(inviteeEmail);
    await ctx.http().post('/api/v1/invitations/accept').send({ token }).expect(401);

    const accepted = await ctx
      .http()
      .post('/api/v1/invitations/accept')
      .set(as(invitee))
      .send({ token })
      .expect(200);
    expect(accepted.body).toEqual({ organisationId: organisation.id, role: 'COMPLIANCE_MANAGER' });

    // exactly once; nothing secret left behind
    const replay = await ctx
      .http()
      .post('/api/v1/invitations/accept')
      .set(as(invitee))
      .send({ token })
      .expect(400);
    expect(replay.body.code).toBe('INVALID_TOKEN');
    const spent = await ctx.admin.invitation.findUniqueOrThrow({ where: { id: created.body.id } });
    expect(spent).toMatchObject({
      status: 'ACCEPTED',
      tokenHash: null,
      acceptedByUserId: invitee.id,
    });

    // the new member is real, with the invited role, and the trail names the actors
    const members = await ctx.http().get(`${base}/members`).set(as(admin)).expect(200);
    const joined = members.body.items.find((m: { email: string }) => m.email === inviteeEmail);
    expect(joined).toMatchObject({ role: 'COMPLIANCE_MANAGER', status: 'ACTIVE' });
    expect(members.body.items).toHaveLength(7);
    const events = await ctx.admin.auditEvent.findMany({
      where: { organisationId: organisation.id },
    });
    expect(events.map((e) => e.action).sort()).toEqual([
      'invitation.accepted',
      'invitation.created',
      'membership.created',
    ]);
    expect(events.find((e) => e.action === 'invitation.created')!.actorUserId).toBe(admin.id);
    expect(events.find((e) => e.action === 'invitation.accepted')!.actorUserId).toBe(invitee.id);

    // a revoked or replaced link is dead; resending sends a NEW link that supersedes the old one
    const second = await ctx
      .http()
      .post(`${base}/invitations`)
      .set(as(admin))
      .send({ email: `second-${tag}@example.test`, role: 'READ_ONLY' })
      .expect(201);
    await ctx
      .http()
      .post(`${base}/invitations/${second.body.id}/revoke`)
      .set(as(admin))
      .expect(200);
    const revoked = await ctx.admin.invitation.findUniqueOrThrow({ where: { id: second.body.id } });
    expect(revoked).toMatchObject({ status: 'REVOKED', tokenHash: null });
    await ctx
      .http()
      .post(`${base}/invitations/${second.body.id}/resend`)
      .set(as(admin))
      .expect(409);
  });

  it('member administration: owner-only rules, optimistic locking, deactivation, and the last owner', async () => {
    const { byRole, organisation } = await createOrganisationWithAllRoles(ctx, `adm-${tag}`);
    const { COMPANY_OWNER: owner, COMPANY_ADMIN: admin, STANDARD_USER: staff } = byRole;
    const base = `/api/v1/organisations/${organisation.id}/members`;

    // an admin changes a standard user; a stale version is refused
    const changed = await ctx
      .http()
      .patch(`${base}/${staff.membershipId}`)
      .set(as(admin))
      .send({ role: 'READ_ONLY', version: 1 })
      .expect(200);
    expect(changed.body).toMatchObject({ role: 'READ_ONLY', version: 2 });
    const stale = await ctx
      .http()
      .patch(`${base}/${staff.membershipId}`)
      .set(as(admin))
      .send({ role: 'COMPLIANCE_MANAGER', version: 1 })
      .expect(409);
    expect(stale.body.code).toBe('VERSION_CONFLICT');

    // only an owner touches the Owner role; nobody changes themselves
    const grant = await ctx
      .http()
      .patch(`${base}/${staff.membershipId}`)
      .set(as(admin))
      .send({ role: 'COMPANY_OWNER', version: 2 })
      .expect(403);
    expect(grant.body.code).toBe('OWNER_ONLY');
    await ctx
      .http()
      .patch(`${base}/${owner.membershipId}`)
      .set(as(admin))
      .send({ role: 'READ_ONLY', version: 1 })
      .expect(403);
    const self = await ctx
      .http()
      .patch(`${base}/${owner.membershipId}`)
      .set(as(owner))
      .send({ role: 'READ_ONLY', version: 1 })
      .expect(403);
    expect(self.body.code).toBe('SELF_CHANGE_NOT_ALLOWED');

    // removing a member is the owner's decision (the role lacks users.delete) and takes effect at once
    await ctx
      .http()
      .post(`${base}/${staff.membershipId}/deactivate`)
      .set(as(admin))
      .send({ version: 2 })
      .expect(403);
    const off = await ctx
      .http()
      .post(`${base}/${staff.membershipId}/deactivate`)
      .set(as(owner))
      .send({ version: 2 })
      .expect(200);
    expect(off.body).toMatchObject({ status: 'DEACTIVATED', version: 3 });
    await ctx.http().get(`/api/v1/organisations/${organisation.id}/me`).set(as(staff)).expect(404); // a deactivated member is no longer a member: same answer as a stranger
    const back = await ctx
      .http()
      .post(`${base}/${staff.membershipId}/reactivate`)
      .set(as(owner))
      .send({ version: 3 })
      .expect(200);
    expect(back.body.status).toBe('ACTIVE');
    await ctx.http().get(`/api/v1/organisations/${organisation.id}/me`).set(as(staff)).expect(200);

    const actions = (
      await ctx.admin.auditEvent.findMany({ where: { organisationId: organisation.id } })
    )
      .map((e) => e.action)
      .sort();
    expect(actions).toEqual([
      'membership.deactivated',
      'membership.reactivated',
      'membership.role_changed',
    ]);
  });

  it('two owners cannot remove each other at the same time: one organisation always keeps an Owner', async () => {
    const { byRole, organisation } = await createOrganisationWithAllRoles(ctx, `own-${tag}`);
    const first = byRole.COMPANY_OWNER;
    const secondPerson = await createPerson(ctx, { label: `second-owner-${tag}` });
    const second = await ctx.admin.membership.create({
      data: { organisationId: organisation.id, userId: secondPerson.id, role: 'COMPANY_OWNER' },
    });
    const base = `/api/v1/organisations/${organisation.id}/members`;

    // each owner demotes the other in the same instant
    const [a, b] = await Promise.all([
      ctx
        .http()
        .patch(`${base}/${second.id}`)
        .set(as(first))
        .send({ role: 'COMPANY_ADMIN', version: 1 }),
      ctx
        .http()
        .patch(`${base}/${first.membershipId}`)
        .set(as(secondPerson))
        .send({ role: 'COMPANY_ADMIN', version: 1 }),
    ]);
    // One request wins. The other is refused either with LAST_OWNER (it passed the access guard while the
    // other still held the Owner role) or with OWNER_ONLY (the winner had already demoted it): both are
    // correct. What must never happen is two successes, which would leave the organisation without an Owner.
    expect([a.status, b.status].filter((status) => status === 200)).toHaveLength(1);
    const loser = a.status === 200 ? b : a;
    expect([403, 409]).toContain(loser.status);
    expect(['LAST_OWNER', 'OWNER_ONLY']).toContain(loser.body.code);
    expect(
      await ctx.admin.membership.count({
        where: { organisationId: organisation.id, role: 'COMPANY_OWNER', status: 'ACTIVE' },
      }),
    ).toBe(1);
  });

  it('every id is scoped to the organisation in the path: a foreign member or invitation is a 404', async () => {
    const a = await createOrganisationWithAllRoles(ctx, `iso-a-${tag}`);
    const b = await createOrganisationWithAllRoles(ctx, `iso-b-${tag}`);
    const foreignInvitation = await ctx.admin.invitation.create({
      data: {
        organisationId: b.organisation.id,
        email: `foreign-${tag}@example.test`,
        role: 'READ_ONLY',
        expiresAt: new Date(Date.now() + 3600_000),
        invitedByUserId: b.byRole.COMPANY_OWNER.id,
      },
    });
    const base = `/api/v1/organisations/${a.organisation.id}`;
    const ownerA = a.byRole.COMPANY_OWNER;
    const foreignMember = b.byRole.STANDARD_USER.membershipId;

    await ctx
      .http()
      .patch(`${base}/members/${foreignMember}`)
      .set(as(ownerA))
      .send({ role: 'READ_ONLY', version: 1 })
      .expect(404);
    await ctx
      .http()
      .post(`${base}/members/${foreignMember}/deactivate`)
      .set(as(ownerA))
      .send({ version: 1 })
      .expect(404);
    await ctx
      .http()
      .post(`${base}/members/${foreignMember}/reactivate`)
      .set(as(ownerA))
      .send({ version: 1 })
      .expect(404);
    await ctx
      .http()
      .post(`${base}/invitations/${foreignInvitation.id}/resend`)
      .set(as(ownerA))
      .expect(404);
    await ctx
      .http()
      .post(`${base}/invitations/${foreignInvitation.id}/revoke`)
      .set(as(ownerA))
      .expect(404);

    // lists show only the organisation's own rows
    const members = await ctx.http().get(`${base}/members`).set(as(ownerA)).expect(200);
    const ids = members.body.items.map((m: { id: string }) => m.id);
    expect(ids).toHaveLength(6);
    expect(ids).not.toContain(foreignMember);
    const invitations = await ctx.http().get(`${base}/invitations`).set(as(ownerA)).expect(200);
    expect(invitations.body.items).toEqual([]);

    // B's member cannot reach A at all, and B's data is untouched
    await ctx.http().get(`${base}/members`).set(as(b.byRole.COMPANY_OWNER)).expect(404);
    await ctx.http().get(`${base}/me`).set(as(b.byRole.COMPANY_OWNER)).expect(404);
    expect(
      await ctx.admin.membership.findUniqueOrThrow({ where: { id: foreignMember } }),
    ).toMatchObject({ role: 'STANDARD_USER', status: 'ACTIVE', version: 1 });
    expect(
      await ctx.admin.invitation.findUniqueOrThrow({ where: { id: foreignInvitation.id } }),
    ).toMatchObject({ status: 'PENDING', version: 1 });
  });

  it('pages members with a cursor', async () => {
    const { byRole, organisation } = await createOrganisationWithAllRoles(ctx, `page-${tag}`);
    const base = `/api/v1/organisations/${organisation.id}/members`;
    const first = await ctx.http().get(`${base}?limit=4`).set(as(byRole.COMPANY_OWNER)).expect(200);
    expect(first.body.items).toHaveLength(4);
    expect(first.body.nextCursor).toBe(first.body.items[3].id);
    const second = await ctx
      .http()
      .get(`${base}?limit=4&after=${first.body.nextCursor}`)
      .set(as(byRole.COMPANY_OWNER))
      .expect(200);
    expect(second.body.items).toHaveLength(2);
    expect(second.body.nextCursor).toBeNull();
    await ctx.http().get(`${base}?limit=1000`).set(as(byRole.COMPANY_OWNER)).expect(400);
  });

  it('platform administration: provisions an organisation without gaining access to it', async () => {
    const root = await createPerson(ctx, { label: `root-${tag}` });
    const ordinary = await createPerson(ctx, { label: `ordinary-${tag}` });
    await ctx.admin.user.update({ where: { id: root.id }, data: { isPlatformAdmin: true } });
    const ownerEmail = `first-owner-${tag}@example.test`;

    // only the flag opens /platform/*
    await ctx.http().get('/api/v1/platform/organisations').set(as(ordinary)).expect(403);
    await ctx
      .http()
      .post('/api/v1/platform/organisations')
      .set(as(ordinary))
      .send({ name: 'Nope', timezone: 'UTC', ownerEmail })
      .expect(403);
    const meRoot = await ctx.http().get('/api/v1/me').set(as(root)).expect(200);
    expect(meRoot.body.isPlatformAdmin).toBe(true);

    const provisioned = await ctx
      .http()
      .post('/api/v1/platform/organisations')
      .set(as(root))
      .send({ name: `Provisioned ${tag}`, timezone: 'Europe/London', ownerEmail })
      .expect(201);
    expect(provisioned.body).toMatchObject({ name: `Provisioned ${tag}`, ownerEmail });
    const organisationId = provisioned.body.id as string;

    // names and counts only
    const list = await ctx.http().get('/api/v1/platform/organisations').set(as(root)).expect(200);
    const row = list.body.items.find((o: { id: string }) => o.id === organisationId);
    expect(row).toMatchObject({ memberCount: 0, ownerCount: 0, pendingInvitations: 1 });
    expect(JSON.stringify(row)).not.toContain(ownerEmail);

    // the first Owner receives an ordinary invitation and accepts it
    await ctx.runner.runBatch({ limit: 20 });
    const [mail] = await mailsTo(ownerEmail);
    expect(mail).toBeDefined();
    const owner = await createPerson(ctx, { email: ownerEmail });
    await ctx
      .http()
      .post('/api/v1/invitations/accept')
      .set(as(owner))
      .send({ token: mail!.token })
      .expect(200);
    const after = await ctx.http().get('/api/v1/platform/organisations').set(as(root)).expect(200);
    expect(after.body.items.find((o: { id: string }) => o.id === organisationId)).toMatchObject({
      memberCount: 1,
      ownerCount: 1,
      pendingInvitations: 0,
    });

    // the platform administrator is NOT a member: no tenant route opens for them
    await ctx
      .http()
      .get(`/api/v1/organisations/${organisationId}/members`)
      .set(as(root))
      .expect(404);
    const mine = await ctx.http().get('/api/v1/organisations').set(as(root)).expect(200);
    expect(mine.body.map((o: { id: string }) => o.id)).not.toContain(organisationId);
    const trail = await ctx.admin.auditEvent.findMany({ where: { organisationId } });
    expect(trail.find((e) => e.action === 'organisation.created')!.actorUserId).toBe(root.id);
  });
});
