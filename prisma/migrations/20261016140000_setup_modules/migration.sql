-- AlterTable
ALTER TABLE "organisations" ADD COLUMN     "address" TEXT,
ADD COLUMN     "country" TEXT,
ADD COLUMN     "display_name" TEXT,
ADD COLUMN     "dpo_email" TEXT,
ADD COLUMN     "dpo_name" TEXT,
ADD COLUMN     "dpo_phone" TEXT,
ADD COLUMN     "legal_name" TEXT,
ADD COLUMN     "logo_content_type" TEXT,
ADD COLUMN     "logo_key" TEXT,
ADD COLUMN     "logo_sha256" TEXT,
ADD COLUMN     "logo_size" INTEGER,
ADD COLUMN     "logo_updated_at" TIMESTAMPTZ,
ADD COLUMN     "registration_number" TEXT;

-- CreateTable
CREATE TABLE "regulator_contacts" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "authority_name" TEXT NOT NULL,
    "jurisdiction" TEXT,
    "contact_name" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "notes" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "regulator_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "business_units" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "description" TEXT,
    "archived_at" TIMESTAMPTZ,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "business_units_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "frameworks" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "jurisdiction" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "frameworks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organisation_frameworks" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "framework_id" UUID NOT NULL,
    "added_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removed_at" TIMESTAMPTZ,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "organisation_frameworks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plans" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "max_users" INTEGER,
    "api_access" BOOLEAN NOT NULL DEFAULT false,
    "is_visible" BOOLEAN NOT NULL DEFAULT true,
    "is_placeholder" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organisation_entitlements" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "plan_code" TEXT NOT NULL,
    "plan_name" TEXT NOT NULL,
    "max_users" INTEGER,
    "api_access" BOOLEAN NOT NULL,
    "assigned_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assigned_by_user_id" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "organisation_entitlements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "regulator_contacts_organisation_id_authority_name_idx" ON "regulator_contacts"("organisation_id", "authority_name");

-- CreateIndex
CREATE UNIQUE INDEX "regulator_contacts_organisation_id_id_key" ON "regulator_contacts"("organisation_id", "id");

-- CreateIndex
CREATE INDEX "business_units_organisation_id_archived_at_idx" ON "business_units"("organisation_id", "archived_at");

-- CreateIndex
CREATE UNIQUE INDEX "business_units_organisation_id_id_key" ON "business_units"("organisation_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "frameworks_code_key" ON "frameworks"("code");

-- CreateIndex
CREATE UNIQUE INDEX "organisation_frameworks_organisation_id_id_key" ON "organisation_frameworks"("organisation_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "organisation_frameworks_organisation_id_framework_id_key" ON "organisation_frameworks"("organisation_id", "framework_id");

-- CreateIndex
CREATE UNIQUE INDEX "plans_code_key" ON "plans"("code");

-- CreateIndex
CREATE UNIQUE INDEX "organisation_entitlements_organisation_id_key" ON "organisation_entitlements"("organisation_id");

-- CreateIndex
CREATE UNIQUE INDEX "organisation_entitlements_organisation_id_id_key" ON "organisation_entitlements"("organisation_id", "id");

-- AddForeignKey
ALTER TABLE "regulator_contacts" ADD CONSTRAINT "regulator_contacts_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_units" ADD CONSTRAINT "business_units_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organisation_frameworks" ADD CONSTRAINT "organisation_frameworks_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organisation_frameworks" ADD CONSTRAINT "organisation_frameworks_framework_id_fkey" FOREIGN KEY ("framework_id") REFERENCES "frameworks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organisation_entitlements" ADD CONSTRAINT "organisation_entitlements_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organisation_entitlements" ADD CONSTRAINT "organisation_entitlements_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organisation_entitlements" ADD CONSTRAINT "organisation_entitlements_assigned_by_user_id_fkey" FOREIGN KEY ("assigned_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------------
-- Hand-written additions (not generated by Prisma; they are not part of schema.prisma).
-- ---------------------------------------------------------------------------------------------

-- Impossible rows are rejected by the database, not only by the service.
ALTER TABLE "organisations" ADD CONSTRAINT "organisations_logo_check" CHECK (
  ("logo_key" IS NULL) = ("logo_content_type" IS NULL)
  AND ("logo_key" IS NULL) = ("logo_size" IS NULL)
  AND ("logo_key" IS NULL) = ("logo_sha256" IS NULL)
  AND ("logo_key" IS NULL) = ("logo_updated_at" IS NULL)
);
ALTER TABLE "organisations" ADD CONSTRAINT "organisations_dpo_email_check"
  CHECK ("dpo_email" IS NULL OR "dpo_email" = lower("dpo_email"));
ALTER TABLE "regulator_contacts" ADD CONSTRAINT "regulator_contacts_email_check"
  CHECK ("email" IS NULL OR "email" = lower("email"));
ALTER TABLE "regulator_contacts" ADD CONSTRAINT "regulator_contacts_name_check"
  CHECK (length(btrim("authority_name")) BETWEEN 1 AND 160);
ALTER TABLE "business_units" ADD CONSTRAINT "business_units_name_check"
  CHECK (length(btrim("name")) BETWEEN 1 AND 120);
ALTER TABLE "plans" ADD CONSTRAINT "plans_max_users_check" CHECK ("max_users" IS NULL OR "max_users" >= 1);
ALTER TABLE "organisation_entitlements" ADD CONSTRAINT "organisation_entitlements_max_users_check"
  CHECK ("max_users" IS NULL OR "max_users" >= 1);

-- A business unit's name and code are unique per organisation among NON-archived units (case-insensitive).
-- Prisma cannot model partial or expression indexes.
CREATE UNIQUE INDEX "business_units_active_name_key"
  ON "business_units" ("organisation_id", lower("name")) WHERE "archived_at" IS NULL;
CREATE UNIQUE INDEX "business_units_active_code_key"
  ON "business_units" ("organisation_id", lower("code")) WHERE "code" IS NOT NULL AND "archived_at" IS NULL;

-- Row-level security for the new tenant tables (ADR-0004; the helper comes from the previous migration).
SELECT "fca_enable_tenant_rls"('regulator_contacts');
SELECT "fca_enable_tenant_rls"('business_units');
SELECT "fca_enable_tenant_rls"('organisation_frameworks');
SELECT "fca_enable_tenant_rls"('organisation_entitlements');

-- Reference data. FRAMEWORKS hold identifiers only (code, a short name, jurisdiction): no legal text and no
-- claim about content; requirement content with provenance arrives in Phase 4. The labels are the owner's own
-- wording. PLANS are PLACEHOLDERS copied from the legacy UI (limits pending commercial confirmation).
INSERT INTO "frameworks" ("id", "code", "name", "jurisdiction", "kind", "sort_order", "updated_at") VALUES
  ('01990001-0000-7000-8001-000000000001', 'CDPA',      'CDPA (Zimbabwe)',              'Zimbabwe',                 'LAW',       10, now()),
  ('01990001-0000-7000-8001-000000000002', 'POPIA',     'POPIA (South Africa)',         'South Africa',             'LAW',       20, now()),
  ('01990001-0000-7000-8001-000000000003', 'GDPR',      'GDPR (European Union)',        'European Union',           'LAW',       30, now()),
  ('01990001-0000-7000-8001-000000000004', 'BDPA',      'BDPA (Botswana)',              'Botswana',                 'LAW',       40, now()),
  ('01990001-0000-7000-8001-000000000005', 'ISO 27701', 'ISO/IEC 27701',                'International',            'STANDARD',  50, now()),
  ('01990001-0000-7000-8001-000000000006', 'NIST CSF',  'NIST Cybersecurity Framework', 'United States (voluntary)', 'FRAMEWORK', 60, now());

INSERT INTO "plans" ("id", "code", "name", "description", "max_users", "api_access", "sort_order", "updated_at") VALUES
  ('01990001-0000-7000-8002-000000000001', 'starter',      'Starter',      'Core modules, up to 5 users',                        5,    false, 10, now()),
  ('01990001-0000-7000-8002-000000000002', 'growth',       'Growth',       'Core modules with basic reporting, up to 15 users', 15,   false, 20, now()),
  ('01990001-0000-7000-8002-000000000003', 'professional', 'Professional', 'Advanced reporting, up to 25 users',                25,   false, 30, now()),
  ('01990001-0000-7000-8002-000000000004', 'enterprise',   'Enterprise',   'Unlimited users, API access and dedicated support', NULL, true,  40, now());

-- The platform list also shows each organisation's plan (the assignment is a snapshot in organisation_entitlements).
DROP FUNCTION "fca_platform_organisations"(integer, uuid);
CREATE FUNCTION "fca_platform_organisations"(p_limit integer, p_after uuid)
RETURNS TABLE (
  "organisation_id" uuid,
  "name" text,
  "timezone" text,
  "created_at" timestamptz,
  "member_count" bigint,
  "owner_count" bigint,
  "pending_invitations" bigint,
  "plan_name" text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT o."id", o."name", o."timezone", o."created_at",
    (SELECT count(*) FROM "memberships" m WHERE m."organisation_id" = o."id" AND m."status" = 'ACTIVE'),
    (SELECT count(*) FROM "memberships" m WHERE m."organisation_id" = o."id" AND m."status" = 'ACTIVE' AND m."role" = 'COMPANY_OWNER'),
    (SELECT count(*) FROM "invitations" i WHERE i."organisation_id" = o."id" AND i."status" = 'PENDING'),
    (SELECT e."plan_name" FROM "organisation_entitlements" e WHERE e."organisation_id" = o."id")
  FROM "organisations" o
  WHERE p_after IS NULL OR o."id" < p_after
  ORDER BY o."id" DESC
  -- 101 = the largest page (100) plus the extra row the caller fetches to learn whether another page exists
  LIMIT LEAST(GREATEST(p_limit, 1), 101)
$$;
REVOKE ALL ON FUNCTION "fca_platform_organisations"(integer, uuid) FROM PUBLIC;
