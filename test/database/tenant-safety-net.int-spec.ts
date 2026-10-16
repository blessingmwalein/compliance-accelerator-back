import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantScopeError } from '../../src/database/tenant-guard.js';
import { createIntContext, seedTwoOrganisations, type IntContext } from '../support/int-context.js';

describe('tenant safety net on a real database', () => {
  let ctx: IntContext;
  let seed: Awaited<ReturnType<typeof seedTwoOrganisations>>;

  beforeAll(async () => {
    ctx = await createIntContext();
    seed = await seedTwoOrganisations(ctx.admin);
  });
  afterAll(async () => {
    await ctx.close();
  });

  const asA = <T>(fn: () => Promise<T>) =>
    ctx.requestContext.run({ organisationId: seed.a.organisation.id }, fn);
  /** Tenant data is read inside a unit of work: it sets the tenant for row-level security (a bare query sees nothing). */
  const inTx = <T>(fn: (tx: Parameters<Parameters<typeof ctx.uow.run>[0]>[0]) => Promise<T>) =>
    asA(() => ctx.uow.run(fn));

  it('a tenant reads only its own rows', async () => {
    const rows = await inTx((tx) =>
      tx.membership.findMany({ where: { organisationId: seed.a.organisation.id } }),
    );
    expect(rows.map((row) => row.id)).toEqual([seed.a.membership.id]);
  });

  it("another tenant's record is simply not found (the 404 rule), even by its exact id", async () => {
    const row = await inTx((tx) =>
      tx.membership.findFirst({
        where: { id: seed.b.membership.id, organisationId: seed.a.organisation.id },
      }),
    );
    expect(row).toBeNull();
  });

  it('refuses to query the other tenant even though the rows exist', async () => {
    await expect(
      asA(() =>
        ctx.prisma.db.membership.findMany({ where: { organisationId: seed.b.organisation.id } }),
      ),
    ).rejects.toMatchObject({ failure: 'TENANT_MISMATCH' });
  });

  it('refuses the bare-id lookup', async () => {
    await expect(
      asA(() => ctx.prisma.db.membership.findUnique({ where: { id: seed.a.membership.id } })),
    ).rejects.toBeInstanceOf(TenantScopeError);
  });

  it('refuses every tenant-model query outside a verified tenant scope', async () => {
    await expect(
      ctx.prisma.db.membership.findMany({ where: { organisationId: seed.a.organisation.id } }),
    ).rejects.toMatchObject({ failure: 'TENANT_CONTEXT_MISSING' });
  });

  it('refuses to create a row for another tenant', async () => {
    await expect(
      asA(() =>
        ctx.prisma.db.idempotencyKey.create({
          data: {
            organisationId: seed.b.organisation.id,
            key: 'k',
            endpoint: 'POST /x',
            requestHash: 'h',
            expiresAt: new Date(Date.now() + 60_000),
          },
        }),
      ),
    ).rejects.toMatchObject({ failure: 'TENANT_MISMATCH' });
  });

  it('applies inside interactive transactions too', async () => {
    await expect(
      asA(() =>
        ctx.uow.run(async (tx) =>
          tx.membership.findMany({ where: { organisationId: seed.b.organisation.id } }),
        ),
      ),
    ).rejects.toMatchObject({ failure: 'TENANT_MISMATCH' });
  });

  it('the database itself keeps one membership per (organisation, user)', async () => {
    await expect(
      ctx.admin.membership.create({
        data: { organisationId: seed.a.organisation.id, userId: seed.a.user.id, role: 'READ_ONLY' },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('the database stores emails in lower case only', async () => {
    await expect(
      ctx.admin.user.create({ data: { email: 'Mixed@Example.test', fullName: 'Mixed' } }),
    ).rejects.toThrow(/users_email_lowercase_check/);
  });
});
