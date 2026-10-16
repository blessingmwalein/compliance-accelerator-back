import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sha256Hex } from '../../src/auth/tokens.js';
import { Prisma } from '../../src/generated/prisma/client.js';
import { createIntContext, seedTwoOrganisations, type IntContext } from '../support/int-context.js';

/**
 * Row-level security, last of the five tenancy layers (ADR-0004), proven for the runtime role on the
 * real database. These queries deliberately BYPASS the repositories and the Prisma safety net: the
 * point is that the DATABASE refuses to leak even when application code is wrong.
 */
describe('row-level security for the runtime role', () => {
  let ctx: IntContext;
  let seed: Awaited<ReturnType<typeof seedTwoOrganisations>>;
  let invitationToken: string;

  beforeAll(async () => {
    ctx = await createIntContext();
    seed = await seedTwoOrganisations(ctx.admin);
    invitationToken = `rls-token-${randomUUID()}-${randomUUID()}`;
    await ctx.admin.invitation.create({
      data: {
        organisationId: seed.b.organisation.id,
        email: `rls-invitee-${randomUUID().slice(0, 6)}@example.test`,
        role: 'READ_ONLY',
        expiresAt: new Date(Date.now() + 3_600_000),
        invitedByUserId: seed.b.user.id,
        tokenHash: sha256Hex(invitationToken),
      },
    });
    await ctx.admin.idempotencyKey.create({
      data: {
        organisationId: seed.a.organisation.id,
        key: 'rls-seed',
        endpoint: 'POST /rls',
        requestHash: 'h',
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    await ctx.admin.auditEvent.create({
      data: {
        organisationId: seed.a.organisation.id,
        actorType: 'SYSTEM',
        action: 'organisation.created',
        entityType: 'organisation',
      },
    });
    await ctx.admin.auditEvent.create({
      data: {
        organisationId: seed.b.organisation.id,
        actorType: 'SYSTEM',
        action: 'organisation.created',
        entityType: 'organisation',
      },
    });
  });
  afterAll(async () => {
    await ctx.close();
  });

  /** A transaction as the runtime role with the tenant setting the unit of work would set. */
  const asTenant = <T>(
    organisationId: string | null,
    fn: (tx: typeof ctx.prisma.db) => Promise<T>,
  ) =>
    ctx.prisma.db.$transaction(
      async (tx) => {
        if (organisationId)
          await tx.$queryRaw`SELECT set_config('app.org_id', ${organisationId}, true)`;
        return fn(tx as unknown as typeof ctx.prisma.db);
      },
      { maxWait: 60_000, timeout: 60_000 },
    );

  const TENANT_TABLES = ['memberships', 'invitations', 'audit_events', 'idempotency_keys'] as const;

  it('every table with an organisation_id has RLS enabled, forced and a tenant_isolation policy', async () => {
    const rows = await ctx.admin.$queryRaw<
      Array<{ table_name: string; rls: boolean; forced: boolean; policies: number }>
    >`
      SELECT c.relname AS table_name, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
             (SELECT count(*)::int FROM pg_policies p
               WHERE p.schemaname = 'public' AND p.tablename = c.relname AND p.policyname = 'tenant_isolation') AS policies
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
      WHERE c.relkind = 'r'
        AND (
          EXISTS (SELECT 1 FROM information_schema.columns k
                  WHERE k.table_schema = 'public' AND k.table_name = c.relname AND k.column_name = 'organisation_id')
          OR c.relname = 'organisations'
        )
      ORDER BY c.relname`;
    // a new tenant table without a policy fails here (call fca_enable_tenant_rls in its migration)
    expect(rows.map((r) => r.table_name)).toEqual(
      expect.arrayContaining([...TENANT_TABLES, 'organisations']),
    );
    for (const row of rows) {
      expect(row, row.table_name).toMatchObject({ rls: true, forced: true, policies: 1 });
    }
  });

  it.each([...TENANT_TABLES, 'organisations'])(
    'fails closed on %s: without a tenant the runtime role sees no rows, though they exist',
    async (table) => {
      // the table name comes from the constant list above, never from input
      const count = Prisma.sql`SELECT count(*)::int AS n FROM ${Prisma.raw(`"${table}"`)}`;
      const owner = await ctx.admin.$queryRaw<Array<{ n: number }>>(count);
      expect(owner[0]!.n).toBeGreaterThan(0);
      const rows = await ctx.prisma.db.$queryRaw<Array<{ n: number }>>(count);
      expect(rows[0]!.n).toBe(0);
    },
  );

  it('a plain "SELECT * FROM memberships" with no WHERE returns only the current tenant (raw SQL cannot leak)', async () => {
    const asA = await asTenant(
      seed.a.organisation.id,
      (tx) =>
        tx.$queryRaw<Array<{ organisation_id: string }>>`SELECT organisation_id FROM memberships`,
    );
    expect(asA.length).toBeGreaterThan(0);
    expect(new Set(asA.map((row) => row.organisation_id))).toEqual(
      new Set([seed.a.organisation.id]),
    );

    const asB = await asTenant(
      seed.b.organisation.id,
      (tx) =>
        tx.$queryRaw<Array<{ organisation_id: string }>>`SELECT organisation_id FROM memberships`,
    );
    expect(new Set(asB.map((row) => row.organisation_id))).toEqual(
      new Set([seed.b.organisation.id]),
    );
  });

  it('the setting does not outlive its transaction on a pooled connection', async () => {
    await asTenant(seed.a.organisation.id, (tx) => tx.$queryRaw`SELECT 1`);
    for (let i = 0; i < 4; i++) {
      const rows = await ctx.prisma.db.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM memberships`;
      expect(rows[0]!.n).toBe(0);
    }
  });

  it('rejects writing a row for another tenant, whatever the application code says (WITH CHECK)', async () => {
    await expect(
      asTenant(
        seed.a.organisation.id,
        (tx) =>
          tx.$executeRaw`
          INSERT INTO audit_events (id, organisation_id, actor_type, action, entity_type)
          VALUES (${randomUUID()}::uuid, ${seed.b.organisation.id}::uuid, 'SYSTEM', 'x.y', 'z')`,
      ),
    ).rejects.toThrow();
    expect(
      await ctx.admin.auditEvent.count({
        where: { organisationId: seed.b.organisation.id, action: 'x.y' },
      }),
    ).toBe(0);
  });

  it("another tenant's rows cannot be updated or deleted either (they are invisible)", async () => {
    const updated = await asTenant(
      seed.a.organisation.id,
      (tx) =>
        tx.$executeRaw`UPDATE memberships SET role = 'READ_ONLY' WHERE id = ${seed.b.membership.id}::uuid`,
    );
    const deleted = await asTenant(
      seed.a.organisation.id,
      (tx) =>
        tx.$executeRaw`DELETE FROM invitations WHERE organisation_id = ${seed.b.organisation.id}::uuid`,
    );
    expect(updated).toBe(0);
    expect(deleted).toBe(0);
    expect(
      await ctx.admin.membership.findUniqueOrThrow({ where: { id: seed.b.membership.id } }),
    ).toMatchObject({ role: 'COMPANY_OWNER' });
  });

  it('the runtime role cannot switch RLS off or call the owner-only helper', async () => {
    await expect(
      ctx.prisma.db.$executeRaw`ALTER TABLE memberships DISABLE ROW LEVEL SECURITY`,
    ).rejects.toThrow();
    await expect(
      ctx.prisma.db.$executeRaw`DROP POLICY tenant_isolation ON memberships`,
    ).rejects.toThrow();
    await expect(
      ctx.prisma.db.$queryRaw`SELECT fca_enable_tenant_rls('memberships')`,
    ).rejects.toThrow();
  });

  describe('the lookups that run before a tenant is known return only what was asked for', () => {
    it("fca_membership_of: the caller's own membership in the named organisation, nothing else", async () => {
      const own = await ctx.prisma.db.$queryRaw<Array<{ role: string; organisation_name: string }>>`
        SELECT role::text AS role, organisation_name FROM fca_membership_of(${seed.a.user.id}::uuid, ${seed.a.organisation.id}::uuid)`;
      expect(own).toEqual([{ role: 'COMPANY_OWNER', organisation_name: seed.a.organisation.name }]);

      const foreign = await ctx.prisma.db.$queryRaw<unknown[]>`
        SELECT * FROM fca_membership_of(${seed.a.user.id}::uuid, ${seed.b.organisation.id}::uuid)`;
      expect(foreign).toEqual([]);
    });

    it("fca_memberships_of_user: only the caller's active organisations", async () => {
      const rows = await ctx.prisma.db.$queryRaw<Array<{ organisation_id: string }>>`
        SELECT organisation_id FROM fca_memberships_of_user(${seed.a.user.id}::uuid)`;
      expect(rows.map((row) => row.organisation_id)).toEqual([seed.a.organisation.id]);
    });

    it('fca_invitation_by_token: exactly the invitation of that token hash', async () => {
      const found = await ctx.prisma.db.$queryRaw<
        Array<{ organisation_id: string; status: string }>
      >`
        SELECT organisation_id, status::text AS status FROM fca_invitation_by_token(${sha256Hex(invitationToken)})`;
      expect(found).toEqual([{ organisation_id: seed.b.organisation.id, status: 'PENDING' }]);
      const unknown = await ctx.prisma.db.$queryRaw<unknown[]>`
        SELECT * FROM fca_invitation_by_token(${sha256Hex('not-a-token')})`;
      expect(unknown).toEqual([]);
    });

    it('fca_platform_organisations: names and counts only', async () => {
      const rows = await ctx.prisma.db.$queryRaw<
        Array<{ organisation_id: string; name: string; member_count: bigint }>
      >`SELECT organisation_id, name, member_count FROM fca_platform_organisations(100, NULL)`;
      const ids = rows.map((row) => row.organisation_id);
      expect(ids).toContain(seed.a.organisation.id);
      expect(ids).toContain(seed.b.organisation.id);
      expect(
        Number(rows.find((r) => r.organisation_id === seed.a.organisation.id)!.member_count),
      ).toBe(1);
    });
  });
});
