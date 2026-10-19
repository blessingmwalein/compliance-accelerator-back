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
REVOKE UPDATE, DELETE, TRUNCATE ON "remediation_task_events" FROM fca_app;
REVOKE UPDATE, DELETE, TRUNCATE ON "risk_acceptances" FROM fca_app;
REVOKE UPDATE, DELETE, TRUNCATE ON "retention_disposals" FROM fca_app;

-- Phase 7: the ledgers of an incident and the file history of an evidence item are evidence themselves.
REVOKE UPDATE, DELETE, TRUNCATE ON "dsar_extensions" FROM fca_app;
REVOKE UPDATE, DELETE, TRUNCATE ON "dsar_communications" FROM fca_app;
REVOKE UPDATE, DELETE, TRUNCATE ON "breach_chronology_entries" FROM fca_app;
REVOKE UPDATE, DELETE, TRUNCATE ON "breach_notification_decisions" FROM fca_app;
REVOKE UPDATE, DELETE, TRUNCATE ON "evidence_versions" FROM fca_app;

-- An alert delivery row is created when the alert is queued and its outcome is filled in when the job runs;
-- the guard trigger limits which columns may change and nothing here is ever deleted.
REVOKE DELETE, TRUNCATE ON "alert_deliveries" FROM fca_app;

-- A legal hold is placed and then released; releasing it is the only update, and it is never deleted.
REVOKE DELETE, TRUNCATE ON "legal_holds" FROM fca_app;

-- Registers are archived, never deleted: the runtime role has no DELETE on them at all.
REVOKE DELETE, TRUNCATE ON "classification_levels" FROM fca_app;
REVOKE DELETE, TRUNCATE ON "ropa_activities" FROM fca_app;
REVOKE DELETE, TRUNCATE ON "lawful_basis_records" FROM fca_app;
REVOKE DELETE, TRUNCATE ON "retention_rules" FROM fca_app;

-- Incidents and reminders are completed, refused, withdrawn or cancelled — never deleted (Phase 7).
REVOKE DELETE, TRUNCATE ON "dsar_requests" FROM fca_app;
REVOKE DELETE, TRUNCATE ON "breaches" FROM fca_app;
REVOKE DELETE, TRUNCATE ON "reminders" FROM fca_app;

-- Verified framework content is written only by the owner-run loader (npm run frameworks:load): the runtime
-- role can read it, never change it (the compliance_mapping migration also adds immutability triggers).
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "framework_versions" FROM fca_app;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "requirements" FROM fca_app;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "mapping_pack_entries" FROM fca_app;

-- Quick-start assessment templates are published by a migration, never by the application.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "assessment_templates" FROM fca_app;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "assessment_template_items" FROM fca_app;

-- Prisma's own bookkeeping table is owner-only.
REVOKE ALL ON "_prisma_migrations" FROM fca_app;

-- The pre-tenant lookups (see the rbac_invitations migration). Explicit, never ALL FUNCTIONS: a future
-- helper that changes the schema must not become callable by the runtime role by accident.
GRANT EXECUTE ON FUNCTION "fca_membership_of"(uuid, uuid) TO fca_app;
GRANT EXECUTE ON FUNCTION "fca_memberships_of_user"(uuid) TO fca_app;
GRANT EXECUTE ON FUNCTION "fca_invitation_by_token"(text) TO fca_app;
GRANT EXECUTE ON FUNCTION "fca_platform_organisations"(integer, uuid) TO fca_app;
