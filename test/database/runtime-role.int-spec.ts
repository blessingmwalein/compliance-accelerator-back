import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createIntContext, type IntContext } from '../support/int-context.js';

/**
 * AC-AUD-02 at the privilege level. These FAIL until the runtime role exists and
 * prisma/sql/runtime-role.sql was applied to the test branch (docs/neon-setup.md, section
 * "Runtime role"): a runtime connection that owns the tables or can UPDATE audit_events is a
 * misconfiguration this suite must not paper over.
 */
describe('the runtime role (connection used by the application)', () => {
  let ctx: IntContext;

  beforeAll(async () => {
    ctx = await createIntContext();
  });
  afterAll(async () => {
    await ctx.close();
  });

  const privilege = async (privilegeName: string) => {
    const rows = await ctx.prisma.db.$queryRaw<{ allowed: boolean }[]>`
      SELECT has_table_privilege(current_user, 'audit_events', ${privilegeName}) AS allowed`;
    return rows[0]?.allowed;
  };

  it.each(['UPDATE', 'DELETE', 'TRUNCATE'])('has no %s privilege on audit_events', async (name) => {
    expect(await privilege(name)).toBe(false);
  });

  it('can INSERT and SELECT audit events', async () => {
    expect(await privilege('INSERT')).toBe(true);
    expect(await privilege('SELECT')).toBe(true);
  });

  it('is not the owner of the tables and cannot bypass row-level security', async () => {
    const rows = await ctx.prisma.db.$queryRaw<{ owner: string; me: string; bypass: boolean }[]>`
      SELECT t.tableowner AS owner, current_user AS me, r.rolbypassrls AS bypass
      FROM pg_tables t, pg_roles r
      WHERE t.schemaname = 'public' AND t.tablename = 'audit_events' AND r.rolname = current_user`;
    expect(rows[0]?.me).not.toBe(rows[0]?.owner);
    expect(rows[0]?.bypass).toBe(false);
  });
});
