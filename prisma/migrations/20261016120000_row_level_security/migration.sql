-- Row-level security as the last tenancy layer (ADR-0004 layer 5). Hand-written: it changes no table
-- shape, so Prisma generates nothing for it.
--
-- Every tenant table gets ONE policy, `tenant_isolation`: a row is visible and writable only when its
-- organisation equals the transaction-local setting `app.org_id`, which the unit of work sets with
-- set_config(..., true) as its first statement (transaction-local, therefore safe behind PgBouncer).
-- With no setting the policy matches nothing: it FAILS CLOSED. The runtime role (fca_app) owns nothing and
-- has no BYPASSRLS, so the policies bind it; the owner role used for migrations and test seeding bypasses them.
--
-- The few reads that happen before a tenant is known go through the SECURITY DEFINER functions of the
-- previous migration (they run as the owner and return only the caller's own rows).

CREATE FUNCTION "fca_enable_tenant_rls"(p_table text, p_column text DEFAULT 'organisation_id')
RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  predicate text := format('%I = nullif(current_setting(''app.org_id'', true), '''')::uuid', p_column);
BEGIN
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', p_table);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', p_table);
  EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', p_table);
  EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (%s) WITH CHECK (%s)', p_table, predicate, predicate);
END
$$;

-- An owner-only helper: never granted to the runtime role. A migration that adds a tenant table calls it
-- (test/database/rls.int-spec.ts fails when a table with organisation_id has no policy).
REVOKE ALL ON FUNCTION "fca_enable_tenant_rls"(text, text) FROM PUBLIC;

SELECT "fca_enable_tenant_rls"('memberships');
SELECT "fca_enable_tenant_rls"('invitations');
SELECT "fca_enable_tenant_rls"('audit_events');
SELECT "fca_enable_tenant_rls"('idempotency_keys');
-- The tenant root: its own id IS the tenant id.
SELECT "fca_enable_tenant_rls"('organisations', 'id');
