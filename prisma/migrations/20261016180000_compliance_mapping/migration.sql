-- CreateEnum
CREATE TYPE "FrameworkVersionStatus" AS ENUM ('DRAFT', 'VERIFIED', 'PUBLISHED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "LicenceClass" AS ENUM ('PUBLIC_DOMAIN', 'OPEN_REUSE', 'LICENSED_TEXT', 'USER_SUPPLIED');

-- CreateEnum
CREATE TYPE "TextSource" AS ENUM ('VERBATIM', 'PARAPHRASE', 'REFERENCE_ONLY');

-- CreateEnum
CREATE TYPE "MappingRelationship" AS ENUM ('EXACT', 'PARTIAL', 'RELATED');

-- CreateEnum
CREATE TYPE "MappingOrigin" AS ENUM ('SEED', 'USER');

-- CreateEnum
CREATE TYPE "MappingReviewStatus" AS ENUM ('DRAFT', 'UNDER_REVIEW', 'APPROVED');

-- CreateTable
CREATE TABLE "framework_versions" (
    "id" UUID NOT NULL,
    "framework_id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "status" "FrameworkVersionStatus" NOT NULL DEFAULT 'DRAFT',
    "licence_class" "LicenceClass" NOT NULL,
    "effective_from" DATE,
    "source_url" TEXT NOT NULL,
    "citation" TEXT NOT NULL,
    "retrieved_at" TIMESTAMPTZ NOT NULL,
    "source_hash" TEXT NOT NULL,
    "content_hash" TEXT NOT NULL,
    "verified_by" TEXT,
    "verified_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "framework_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "requirements" (
    "id" UUID NOT NULL,
    "framework_version_id" UUID NOT NULL,
    "parent_id" UUID,
    "ref" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "text_source" "TextSource" NOT NULL,
    "sort_order" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "requirements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mapping_pack_entries" (
    "id" UUID NOT NULL,
    "from_requirement_id" UUID NOT NULL,
    "to_requirement_id" UUID NOT NULL,
    "relationship" "MappingRelationship" NOT NULL,
    "citation" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mapping_pack_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "governance_areas" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "archived_at" TIMESTAMPTZ,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "governance_areas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organisation_mappings" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "area_id" UUID,
    "from_requirement_id" UUID NOT NULL,
    "to_requirement_id" UUID NOT NULL,
    "relationship" "MappingRelationship" NOT NULL,
    "origin" "MappingOrigin" NOT NULL,
    "source_entry_id" UUID,
    "rationale" TEXT,
    "reference" TEXT,
    "review_status" "MappingReviewStatus" NOT NULL DEFAULT 'DRAFT',
    "archived_at" TIMESTAMPTZ,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "organisation_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "framework_versions_framework_id_status_idx" ON "framework_versions"("framework_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "framework_versions_framework_id_label_key" ON "framework_versions"("framework_id", "label");

-- CreateIndex
CREATE INDEX "requirements_framework_version_id_parent_id_sort_order_idx" ON "requirements"("framework_version_id", "parent_id", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "requirements_framework_version_id_id_key" ON "requirements"("framework_version_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "requirements_framework_version_id_ref_key" ON "requirements"("framework_version_id", "ref");

-- CreateIndex
CREATE UNIQUE INDEX "mapping_pack_entries_from_requirement_id_to_requirement_id_key" ON "mapping_pack_entries"("from_requirement_id", "to_requirement_id");

-- CreateIndex
CREATE INDEX "governance_areas_organisation_id_archived_at_idx" ON "governance_areas"("organisation_id", "archived_at");

-- CreateIndex
CREATE UNIQUE INDEX "governance_areas_organisation_id_id_key" ON "governance_areas"("organisation_id", "id");

-- CreateIndex
CREATE INDEX "organisation_mappings_organisation_id_area_id_idx" ON "organisation_mappings"("organisation_id", "area_id");

-- CreateIndex
CREATE INDEX "organisation_mappings_organisation_id_archived_at_idx" ON "organisation_mappings"("organisation_id", "archived_at");

-- CreateIndex
CREATE INDEX "organisation_mappings_from_requirement_id_idx" ON "organisation_mappings"("from_requirement_id");

-- CreateIndex
CREATE INDEX "organisation_mappings_to_requirement_id_idx" ON "organisation_mappings"("to_requirement_id");

-- CreateIndex
CREATE UNIQUE INDEX "organisation_mappings_organisation_id_id_key" ON "organisation_mappings"("organisation_id", "id");

-- AddForeignKey
ALTER TABLE "framework_versions" ADD CONSTRAINT "framework_versions_framework_id_fkey" FOREIGN KEY ("framework_id") REFERENCES "frameworks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "requirements" ADD CONSTRAINT "requirements_framework_version_id_fkey" FOREIGN KEY ("framework_version_id") REFERENCES "framework_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "requirements" ADD CONSTRAINT "requirements_framework_version_id_parent_id_fkey" FOREIGN KEY ("framework_version_id", "parent_id") REFERENCES "requirements"("framework_version_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mapping_pack_entries" ADD CONSTRAINT "mapping_pack_entries_from_requirement_id_fkey" FOREIGN KEY ("from_requirement_id") REFERENCES "requirements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mapping_pack_entries" ADD CONSTRAINT "mapping_pack_entries_to_requirement_id_fkey" FOREIGN KEY ("to_requirement_id") REFERENCES "requirements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "governance_areas" ADD CONSTRAINT "governance_areas_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organisation_mappings" ADD CONSTRAINT "organisation_mappings_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organisation_mappings" ADD CONSTRAINT "organisation_mappings_organisation_id_area_id_fkey" FOREIGN KEY ("organisation_id", "area_id") REFERENCES "governance_areas"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organisation_mappings" ADD CONSTRAINT "organisation_mappings_from_requirement_id_fkey" FOREIGN KEY ("from_requirement_id") REFERENCES "requirements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organisation_mappings" ADD CONSTRAINT "organisation_mappings_to_requirement_id_fkey" FOREIGN KEY ("to_requirement_id") REFERENCES "requirements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organisation_mappings" ADD CONSTRAINT "organisation_mappings_source_entry_id_fkey" FOREIGN KEY ("source_entry_id") REFERENCES "mapping_pack_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------------------------
-- Hand-written additions (not generated by Prisma; they are not part of schema.prisma).
-- ---------------------------------------------------------------------------------------------

-- Impossible rows are rejected by the database, not only by the service.
ALTER TABLE "framework_versions" ADD CONSTRAINT "framework_versions_label_check"
  CHECK (length(btrim("label")) BETWEEN 1 AND 120);
ALTER TABLE "framework_versions" ADD CONSTRAINT "framework_versions_hash_check"
  CHECK ("source_hash" ~ '^sha256:[0-9a-f]{64}$' AND "content_hash" ~ '^sha256:[0-9a-f]{64}$');
-- anything beyond a draft was verified by a NAMED person at a known time
ALTER TABLE "framework_versions" ADD CONSTRAINT "framework_versions_verified_check"
  CHECK ("status" = 'DRAFT' OR (length(btrim("verified_by")) >= 2 AND "verified_at" IS NOT NULL));

ALTER TABLE "requirements" ADD CONSTRAINT "requirements_text_check" CHECK (
  length(btrim("ref")) BETWEEN 1 AND 60
  AND length(btrim("kind")) BETWEEN 1 AND 40
  AND length(btrim("title")) BETWEEN 1 AND 1000
  AND ("description" IS NULL OR length("description") <= 2000)
  AND "sort_order" >= 0
);

ALTER TABLE "mapping_pack_entries" ADD CONSTRAINT "mapping_pack_entries_check" CHECK (
  "from_requirement_id" <> "to_requirement_id" AND length(btrim("citation")) BETWEEN 1 AND 500
);

ALTER TABLE "governance_areas" ADD CONSTRAINT "governance_areas_name_check"
  CHECK (length(btrim("name")) BETWEEN 1 AND 120);

ALTER TABLE "organisation_mappings" ADD CONSTRAINT "organisation_mappings_check" CHECK (
  "from_requirement_id" <> "to_requirement_id"
  -- a seed row points at its pack entry; a user row never does
  AND (("origin" = 'SEED') = ("source_entry_id" IS NOT NULL))
  -- a user mapping always says why
  AND ("origin" <> 'USER' OR length(btrim("rationale")) BETWEEN 1 AND 1000)
  AND ("rationale" IS NULL OR length("rationale") <= 1000)
  AND ("reference" IS NULL OR length("reference") <= 300)
);

-- Governance area names are unique per organisation among NON-archived areas (case-insensitive).
CREATE UNIQUE INDEX "governance_areas_active_name_key"
  ON "governance_areas" ("organisation_id", lower("name")) WHERE "archived_at" IS NULL;

-- A pack entry is copied into an organisation at most once, in ANY state: Load Default Mappings never
-- duplicates it and never brings back one the organisation archived.
CREATE UNIQUE INDEX "organisation_mappings_source_entry_key"
  ON "organisation_mappings" ("organisation_id", "source_entry_id") WHERE "source_entry_id" IS NOT NULL;
-- The same pair is mapped once among ACTIVE rows.
CREATE UNIQUE INDEX "organisation_mappings_active_pair_key"
  ON "organisation_mappings" ("organisation_id", "from_requirement_id", "to_requirement_id") WHERE "archived_at" IS NULL;

-- Row-level security for the new tenant tables (ADR-0004; the helper comes from the 2c migration).
SELECT "fca_enable_tenant_rls"('governance_areas');
SELECT "fca_enable_tenant_rls"('organisation_mappings');

-- A framework version that has been verified can no longer change: its requirements and pack entries are
-- frozen, its identity and provenance are frozen, and it cannot be deleted. Only its status may move forward
-- (VERIFIED, then PUBLISHED, then SUPERSEDED). A correction is a NEW version. The runtime role cannot write
-- these tables at all (prisma/sql/runtime-role.sql); the triggers also bind the owner role that loads packs.
CREATE FUNCTION "fca_guard_framework_version"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."status" = 'DRAFT' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF; RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'framework version % is % and cannot be deleted', OLD."label", OLD."status";
  END IF;
  IF (NEW."framework_id", NEW."label", NEW."licence_class", NEW."effective_from", NEW."source_url", NEW."citation",
      NEW."retrieved_at", NEW."source_hash", NEW."content_hash", NEW."verified_by", NEW."verified_at")
     IS DISTINCT FROM
     (OLD."framework_id", OLD."label", OLD."licence_class", OLD."effective_from", OLD."source_url", OLD."citation",
      OLD."retrieved_at", OLD."source_hash", OLD."content_hash", OLD."verified_by", OLD."verified_at") THEN
    RAISE EXCEPTION 'framework version % is % and its content and provenance cannot change; create a new version', OLD."label", OLD."status";
  END IF;
  IF NEW."status" = 'DRAFT' THEN
    RAISE EXCEPTION 'framework version % cannot go back to DRAFT', OLD."label";
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "framework_versions_guard" BEFORE UPDATE OR DELETE ON "framework_versions"
  FOR EACH ROW EXECUTE FUNCTION "fca_guard_framework_version"();

CREATE FUNCTION "fca_guard_requirement"() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_status "FrameworkVersionStatus";
BEGIN
  SELECT fv."status" INTO v_status FROM "framework_versions" fv WHERE fv."id" = OLD."framework_version_id";
  IF v_status IS NOT NULL AND v_status <> 'DRAFT' THEN
    RAISE EXCEPTION 'requirement % belongs to a % framework version and cannot be changed or deleted', OLD."ref", v_status;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END
$$;
CREATE TRIGGER "requirements_guard" BEFORE UPDATE OR DELETE ON "requirements"
  FOR EACH ROW EXECUTE FUNCTION "fca_guard_requirement"();

CREATE FUNCTION "fca_guard_mapping_pack_entry"() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_status "FrameworkVersionStatus";
BEGIN
  SELECT fv."status" INTO v_status
  FROM "requirements" r JOIN "framework_versions" fv ON fv."id" = r."framework_version_id"
  WHERE r."id" = OLD."from_requirement_id";
  IF v_status IS NOT NULL AND v_status <> 'DRAFT' THEN
    RAISE EXCEPTION 'a mapping pack entry of a % framework version cannot be changed or deleted', v_status;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END
$$;
CREATE TRIGGER "mapping_pack_entries_guard" BEFORE UPDATE OR DELETE ON "mapping_pack_entries"
  FOR EACH ROW EXECUTE FUNCTION "fca_guard_mapping_pack_entry"();
