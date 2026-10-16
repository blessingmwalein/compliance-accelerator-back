-- DRAFT, not applied by any migration. Run once per Neon branch as the OWNER role (Neon SQL editor or
-- any client on DIRECT_URL), AFTER creating the login role `fca_app` in the Neon console (the password
-- lives in the console and in DATABASE_URL, never in this file). Idempotent: re-run after every
-- migration that adds tables. Status: syntax and privilege semantics verified on an embedded
-- PostgreSQL; NOT yet verified on Neon (spike S5).
--
-- The runtime connects as `fca_app` (pooled DATABASE_URL). It is not the table owner and has no
-- BYPASSRLS, so the row-level security policies (migration row_level_security) bind it.

-- Prisma's pg adapter sends timestamps WITHOUT an offset, so they are only correct when the session
-- TimeZone is UTC (Neon's default). A role-level setting applies at session start, so it also holds behind
-- the transaction-mode pooler (a per-session SET would not). test/database/session-timezone.int-spec.ts checks it.
ALTER ROLE fca_app SET timezone = 'UTC';

GRANT USAGE ON SCHEMA public TO fca_app;

-- Ordinary tables: full DML. TRUNCATE, REFERENCES and TRIGGER are never granted.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO fca_app;

-- Append-only tables: the privilege is withheld in addition to the trigger.
REVOKE UPDATE, DELETE, TRUNCATE ON "audit_events" FROM fca_app;
REVOKE UPDATE, DELETE, TRUNCATE ON "security_events" FROM fca_app;

-- Verified framework content is written only by the owner-run loader (npm run frameworks:load): the runtime
-- role can read it, never change it (the compliance_mapping migration also adds immutability triggers).
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "framework_versions" FROM fca_app;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "requirements" FROM fca_app;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "mapping_pack_entries" FROM fca_app;

-- Prisma's own bookkeeping table is owner-only.
REVOKE ALL ON "_prisma_migrations" FROM fca_app;

-- The pre-tenant lookups (see the rbac_invitations migration). Explicit, never ALL FUNCTIONS: a future
-- helper that changes the schema must not become callable by the runtime role by accident.
GRANT EXECUTE ON FUNCTION "fca_membership_of"(uuid, uuid) TO fca_app;
GRANT EXECUTE ON FUNCTION "fca_memberships_of_user"(uuid) TO fca_app;
GRANT EXECUTE ON FUNCTION "fca_invitation_by_token"(text) TO fca_app;
GRANT EXECUTE ON FUNCTION "fca_platform_organisations"(integer, uuid) TO fca_app;
