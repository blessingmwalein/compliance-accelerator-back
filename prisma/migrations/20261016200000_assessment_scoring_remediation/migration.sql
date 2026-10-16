-- CreateEnum
CREATE TYPE "AssessmentStatus" AS ENUM ('DRAFT', 'IN_REVIEW', 'APPROVED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "RiskLevel" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "TaskPriority" AS ENUM ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'BLOCKED', 'COMPLETED', 'VERIFIED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TaskEventKind" AS ENUM ('COMMENT', 'STATUS_CHANGE', 'ASSIGNMENT');

-- CreateEnum
CREATE TYPE "ReportStatus" AS ENUM ('PENDING', 'READY', 'FAILED');

-- CreateTable
CREATE TABLE "assessments" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" "AssessmentStatus" NOT NULL DEFAULT 'DRAFT',
    "methodology_id" TEXT NOT NULL,
    "methodology_version" INTEGER NOT NULL,
    "exposure_bands" JSONB NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "submitted_at" TIMESTAMPTZ,
    "submitted_by_user_id" UUID,
    "approved_at" TIMESTAMPTZ,
    "approved_by_user_id" UUID,
    "review_comment" TEXT,
    "revises_assessment_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "assessments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assessment_items" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "assessment_id" UUID NOT NULL,
    "governance_area_id" UUID,
    "requirement_id" UUID,
    "business_unit_id" UUID,
    "framework_id" UUID,
    "current_maturity" SMALLINT,
    "target_maturity" SMALLINT,
    "sensitivity" SMALLINT,
    "severity" SMALLINT,
    "likelihood" SMALLINT,
    "gap" SMALLINT,
    "exposure" SMALLINT,
    "risk_level" "RiskLevel",
    "rationale" TEXT,
    "findings" TEXT,
    "owner_membership_id" UUID,
    "last_review_date" DATE,
    "next_review_date" DATE,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "assessment_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "item_priorities" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "assessment_item_id" UUID NOT NULL,
    "answers" JSONB NOT NULL,
    "ruleset_version" INTEGER NOT NULL,
    "urgent_override" BOOLEAN,
    "important_override" BOOLEAN,
    "override_reason" TEXT,
    "adjusted_by_user_id" UUID,
    "adjusted_at" TIMESTAMPTZ,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "item_priorities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assessment_policies" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "exposure_thresholds" JSONB,
    "remediation_due_days" JSONB,
    "plan_window_days" JSONB,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "assessment_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "remediation_tasks" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "assessment_item_id" UUID,
    "governance_area_id" UUID,
    "requirement_id" UUID,
    "business_unit_id" UUID,
    "framework_id" UUID,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "priority" "TaskPriority" NOT NULL,
    "status" "TaskStatus" NOT NULL DEFAULT 'OPEN',
    "assignee_membership_id" UUID,
    "due_date" DATE,
    "auto_generated" BOOLEAN NOT NULL DEFAULT false,
    "snapshot_current_maturity" SMALLINT,
    "snapshot_target_maturity" SMALLINT,
    "snapshot_gap" SMALLINT,
    "snapshot_risk_level" "RiskLevel",
    "created_by_user_id" UUID NOT NULL,
    "completed_at" TIMESTAMPTZ,
    "completed_by_user_id" UUID,
    "verified_at" TIMESTAMPTZ,
    "verified_by_user_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "remediation_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "remediation_task_events" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "kind" "TaskEventKind" NOT NULL,
    "from_status" "TaskStatus",
    "to_status" "TaskStatus",
    "body" TEXT,
    "actor_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "remediation_task_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evidence" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "original_filename" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "uploaded_by_user_id" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assessment_item_evidence" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "assessment_item_id" UUID NOT NULL,
    "evidence_id" UUID NOT NULL,
    "linked_by_user_id" UUID NOT NULL,
    "linked_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assessment_item_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "remediation_task_evidence" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "evidence_id" UUID NOT NULL,
    "linked_by_user_id" UUID NOT NULL,
    "linked_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "remediation_task_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reports" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "template" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "assessment_id" UUID,
    "params" JSONB NOT NULL,
    "status" "ReportStatus" NOT NULL DEFAULT 'READY',
    "data_snapshot" JSONB NOT NULL,
    "storage_key" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "requested_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "assessments_organisation_id_status_idx" ON "assessments"("organisation_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "assessments_organisation_id_id_key" ON "assessments"("organisation_id", "id");

-- CreateIndex
CREATE INDEX "assessment_items_organisation_id_assessment_id_idx" ON "assessment_items"("organisation_id", "assessment_id");

-- CreateIndex
CREATE INDEX "assessment_items_organisation_id_business_unit_id_idx" ON "assessment_items"("organisation_id", "business_unit_id");

-- CreateIndex
CREATE INDEX "assessment_items_organisation_id_framework_id_idx" ON "assessment_items"("organisation_id", "framework_id");

-- CreateIndex
CREATE UNIQUE INDEX "assessment_items_organisation_id_id_key" ON "assessment_items"("organisation_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "item_priorities_organisation_id_id_key" ON "item_priorities"("organisation_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "item_priorities_organisation_id_assessment_item_id_key" ON "item_priorities"("organisation_id", "assessment_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "assessment_policies_organisation_id_key" ON "assessment_policies"("organisation_id");

-- CreateIndex
CREATE UNIQUE INDEX "assessment_policies_organisation_id_id_key" ON "assessment_policies"("organisation_id", "id");

-- CreateIndex
CREATE INDEX "remediation_tasks_organisation_id_status_idx" ON "remediation_tasks"("organisation_id", "status");

-- CreateIndex
CREATE INDEX "remediation_tasks_organisation_id_assignee_membership_id_idx" ON "remediation_tasks"("organisation_id", "assignee_membership_id");

-- CreateIndex
CREATE INDEX "remediation_tasks_organisation_id_assessment_item_id_idx" ON "remediation_tasks"("organisation_id", "assessment_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "remediation_tasks_organisation_id_id_key" ON "remediation_tasks"("organisation_id", "id");

-- CreateIndex
CREATE INDEX "remediation_task_events_organisation_id_task_id_idx" ON "remediation_task_events"("organisation_id", "task_id");

-- CreateIndex
CREATE UNIQUE INDEX "remediation_task_events_organisation_id_id_key" ON "remediation_task_events"("organisation_id", "id");

-- CreateIndex
CREATE INDEX "evidence_organisation_id_created_at_idx" ON "evidence"("organisation_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "evidence_organisation_id_id_key" ON "evidence"("organisation_id", "id");

-- CreateIndex
CREATE INDEX "assessment_item_evidence_organisation_id_evidence_id_idx" ON "assessment_item_evidence"("organisation_id", "evidence_id");

-- CreateIndex
CREATE UNIQUE INDEX "assessment_item_evidence_organisation_id_assessment_item_id_key" ON "assessment_item_evidence"("organisation_id", "assessment_item_id", "evidence_id");

-- CreateIndex
CREATE INDEX "remediation_task_evidence_organisation_id_evidence_id_idx" ON "remediation_task_evidence"("organisation_id", "evidence_id");

-- CreateIndex
CREATE UNIQUE INDEX "remediation_task_evidence_organisation_id_task_id_evidence__key" ON "remediation_task_evidence"("organisation_id", "task_id", "evidence_id");

-- CreateIndex
CREATE INDEX "reports_organisation_id_created_at_idx" ON "reports"("organisation_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "reports_organisation_id_id_key" ON "reports"("organisation_id", "id");

-- AddForeignKey
ALTER TABLE "assessments" ADD CONSTRAINT "assessments_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assessments" ADD CONSTRAINT "assessments_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assessments" ADD CONSTRAINT "assessments_submitted_by_user_id_fkey" FOREIGN KEY ("submitted_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assessments" ADD CONSTRAINT "assessments_approved_by_user_id_fkey" FOREIGN KEY ("approved_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assessments" ADD CONSTRAINT "assessments_organisation_id_revises_assessment_id_fkey" FOREIGN KEY ("organisation_id", "revises_assessment_id") REFERENCES "assessments"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assessment_items" ADD CONSTRAINT "assessment_items_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assessment_items" ADD CONSTRAINT "assessment_items_organisation_id_assessment_id_fkey" FOREIGN KEY ("organisation_id", "assessment_id") REFERENCES "assessments"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assessment_items" ADD CONSTRAINT "assessment_items_organisation_id_governance_area_id_fkey" FOREIGN KEY ("organisation_id", "governance_area_id") REFERENCES "governance_areas"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assessment_items" ADD CONSTRAINT "assessment_items_requirement_id_fkey" FOREIGN KEY ("requirement_id") REFERENCES "requirements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assessment_items" ADD CONSTRAINT "assessment_items_organisation_id_business_unit_id_fkey" FOREIGN KEY ("organisation_id", "business_unit_id") REFERENCES "business_units"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assessment_items" ADD CONSTRAINT "assessment_items_framework_id_fkey" FOREIGN KEY ("framework_id") REFERENCES "frameworks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assessment_items" ADD CONSTRAINT "assessment_items_organisation_id_owner_membership_id_fkey" FOREIGN KEY ("organisation_id", "owner_membership_id") REFERENCES "memberships"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_priorities" ADD CONSTRAINT "item_priorities_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_priorities" ADD CONSTRAINT "item_priorities_organisation_id_assessment_item_id_fkey" FOREIGN KEY ("organisation_id", "assessment_item_id") REFERENCES "assessment_items"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_priorities" ADD CONSTRAINT "item_priorities_adjusted_by_user_id_fkey" FOREIGN KEY ("adjusted_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assessment_policies" ADD CONSTRAINT "assessment_policies_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "remediation_tasks" ADD CONSTRAINT "remediation_tasks_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "remediation_tasks" ADD CONSTRAINT "remediation_tasks_organisation_id_assessment_item_id_fkey" FOREIGN KEY ("organisation_id", "assessment_item_id") REFERENCES "assessment_items"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "remediation_tasks" ADD CONSTRAINT "remediation_tasks_organisation_id_governance_area_id_fkey" FOREIGN KEY ("organisation_id", "governance_area_id") REFERENCES "governance_areas"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "remediation_tasks" ADD CONSTRAINT "remediation_tasks_requirement_id_fkey" FOREIGN KEY ("requirement_id") REFERENCES "requirements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "remediation_tasks" ADD CONSTRAINT "remediation_tasks_organisation_id_business_unit_id_fkey" FOREIGN KEY ("organisation_id", "business_unit_id") REFERENCES "business_units"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "remediation_tasks" ADD CONSTRAINT "remediation_tasks_framework_id_fkey" FOREIGN KEY ("framework_id") REFERENCES "frameworks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "remediation_tasks" ADD CONSTRAINT "remediation_tasks_organisation_id_assignee_membership_id_fkey" FOREIGN KEY ("organisation_id", "assignee_membership_id") REFERENCES "memberships"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "remediation_tasks" ADD CONSTRAINT "remediation_tasks_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "remediation_tasks" ADD CONSTRAINT "remediation_tasks_completed_by_user_id_fkey" FOREIGN KEY ("completed_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "remediation_tasks" ADD CONSTRAINT "remediation_tasks_verified_by_user_id_fkey" FOREIGN KEY ("verified_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "remediation_task_events" ADD CONSTRAINT "remediation_task_events_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "remediation_task_events" ADD CONSTRAINT "remediation_task_events_organisation_id_task_id_fkey" FOREIGN KEY ("organisation_id", "task_id") REFERENCES "remediation_tasks"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "remediation_task_events" ADD CONSTRAINT "remediation_task_events_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_uploaded_by_user_id_fkey" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assessment_item_evidence" ADD CONSTRAINT "assessment_item_evidence_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assessment_item_evidence" ADD CONSTRAINT "assessment_item_evidence_organisation_id_assessment_item_i_fkey" FOREIGN KEY ("organisation_id", "assessment_item_id") REFERENCES "assessment_items"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assessment_item_evidence" ADD CONSTRAINT "assessment_item_evidence_organisation_id_evidence_id_fkey" FOREIGN KEY ("organisation_id", "evidence_id") REFERENCES "evidence"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assessment_item_evidence" ADD CONSTRAINT "assessment_item_evidence_linked_by_user_id_fkey" FOREIGN KEY ("linked_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "remediation_task_evidence" ADD CONSTRAINT "remediation_task_evidence_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "remediation_task_evidence" ADD CONSTRAINT "remediation_task_evidence_organisation_id_task_id_fkey" FOREIGN KEY ("organisation_id", "task_id") REFERENCES "remediation_tasks"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "remediation_task_evidence" ADD CONSTRAINT "remediation_task_evidence_organisation_id_evidence_id_fkey" FOREIGN KEY ("organisation_id", "evidence_id") REFERENCES "evidence"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "remediation_task_evidence" ADD CONSTRAINT "remediation_task_evidence_linked_by_user_id_fkey" FOREIGN KEY ("linked_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_organisation_id_assessment_id_fkey" FOREIGN KEY ("organisation_id", "assessment_id") REFERENCES "assessments"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_requested_by_user_id_fkey" FOREIGN KEY ("requested_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------------------------
-- Hand-written additions (not generated by Prisma; they are not part of schema.prisma).
-- ---------------------------------------------------------------------------------------------

-- Impossible rows are rejected by the database, not only by the service.
ALTER TABLE "assessments" ADD CONSTRAINT "assessments_check" CHECK (
  length(btrim("title")) BETWEEN 1 AND 160
  AND "revises_assessment_id" IS DISTINCT FROM "id"
  -- sign-off is always attributed: who submitted, who approved, and when
  AND ("status" = 'DRAFT' OR ("submitted_at" IS NOT NULL AND "submitted_by_user_id" IS NOT NULL))
  AND ("status" NOT IN ('APPROVED', 'SUPERSEDED') OR ("approved_at" IS NOT NULL AND "approved_by_user_id" IS NOT NULL))
);

ALTER TABLE "assessment_items" ADD CONSTRAINT "assessment_items_check" CHECK (
  ("governance_area_id" IS NOT NULL OR "requirement_id" IS NOT NULL)
  AND ("current_maturity" IS NULL OR "current_maturity" BETWEEN 1 AND 5)
  AND ("target_maturity" IS NULL OR "target_maturity" BETWEEN 1 AND 5)
  AND ("sensitivity" IS NULL OR "sensitivity" BETWEEN 1 AND 5)
  AND ("severity" IS NULL OR "severity" BETWEEN 1 AND 5)
  AND ("likelihood" IS NULL OR "likelihood" BETWEEN 1 AND 5)
  -- derived values exist exactly when their inputs do, and always equal what the inputs give: an unassessed
  -- item has NULL gap and NULL exposure, never a default
  AND (("current_maturity" IS NULL OR "target_maturity" IS NULL) = ("gap" IS NULL))
  AND ("gap" IS NULL OR "gap" = greatest(0, "target_maturity" - "current_maturity"))
  AND (("sensitivity" IS NULL OR "severity" IS NULL OR "likelihood" IS NULL) = ("exposure" IS NULL))
  AND ("exposure" IS NULL OR "exposure" = "sensitivity" * "severity" * "likelihood")
  AND (("exposure" IS NULL) = ("risk_level" IS NULL))
  AND ("rationale" IS NULL OR length("rationale") <= 4000)
  AND ("findings" IS NULL OR length("findings") <= 4000)
);
-- The same subject (area, requirement, business unit, framework) is assessed once per assessment.
CREATE UNIQUE INDEX "assessment_items_subject_key" ON "assessment_items" (
  "assessment_id",
  COALESCE("governance_area_id", '00000000-0000-0000-0000-000000000000'::uuid),
  COALESCE("requirement_id", '00000000-0000-0000-0000-000000000000'::uuid),
  COALESCE("business_unit_id", '00000000-0000-0000-0000-000000000000'::uuid),
  COALESCE("framework_id", '00000000-0000-0000-0000-000000000000'::uuid)
);

ALTER TABLE "item_priorities" ADD CONSTRAINT "item_priorities_check" CHECK (
  "ruleset_version" >= 1
  AND jsonb_typeof("answers") = 'object'
  -- an adjustment always says who, when and why
  AND (("urgent_override" IS NULL AND "important_override" IS NULL)
       OR (length(btrim("override_reason")) BETWEEN 3 AND 1000 AND "adjusted_at" IS NOT NULL AND "adjusted_by_user_id" IS NOT NULL))
);

ALTER TABLE "remediation_tasks" ADD CONSTRAINT "remediation_tasks_check" CHECK (
  length(btrim("title")) BETWEEN 1 AND 200
  AND ("description" IS NULL OR length("description") <= 4000)
  AND ("status" NOT IN ('COMPLETED', 'VERIFIED') OR "completed_at" IS NOT NULL)
  AND (("status" = 'VERIFIED') = ("verified_at" IS NOT NULL AND "verified_by_user_id" IS NOT NULL))
);

ALTER TABLE "remediation_task_events" ADD CONSTRAINT "remediation_task_events_check" CHECK (
  ("body" IS NULL OR length("body") <= 2000)
  AND ("kind" <> 'COMMENT' OR length(btrim("body")) >= 1)
  AND ("kind" <> 'STATUS_CHANGE' OR "to_status" IS NOT NULL)
);

ALTER TABLE "evidence" ADD CONSTRAINT "evidence_check" CHECK (
  length(btrim("title")) BETWEEN 1 AND 200
  AND ("description" IS NULL OR length("description") <= 2000)
  AND "size" > 0
  AND "sha256" ~ '^[0-9a-f]{64}$'
  AND length("storage_key") > 0
);

ALTER TABLE "reports" ADD CONSTRAINT "reports_check" CHECK (
  length(btrim("title")) BETWEEN 1 AND 200 AND "size" > 0 AND "sha256" ~ '^[0-9a-f]{64}$'
);

-- Row-level security for every new tenant table (ADR-0004; the helper comes from the 2c migration).
SELECT "fca_enable_tenant_rls"('assessments');
SELECT "fca_enable_tenant_rls"('assessment_items');
SELECT "fca_enable_tenant_rls"('item_priorities');
SELECT "fca_enable_tenant_rls"('assessment_policies');
SELECT "fca_enable_tenant_rls"('remediation_tasks');
SELECT "fca_enable_tenant_rls"('remediation_task_events');
SELECT "fca_enable_tenant_rls"('evidence');
SELECT "fca_enable_tenant_rls"('assessment_item_evidence');
SELECT "fca_enable_tenant_rls"('remediation_task_evidence');
SELECT "fca_enable_tenant_rls"('reports');

-- The task timeline is append-only, like the audit trail.
CREATE FUNCTION "remediation_task_events_reject_mutation"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'remediation_task_events is append-only (% is not allowed)', TG_OP;
END
$$;
CREATE TRIGGER "remediation_task_events_no_update_delete"
  BEFORE UPDATE OR DELETE ON "remediation_task_events"
  FOR EACH ROW EXECUTE FUNCTION "remediation_task_events_reject_mutation"();

-- Approved assessments are immutable. An assessment past DRAFT cannot be changed or deleted, except that an
-- APPROVED one becomes SUPERSEDED when its revision is approved (nothing else about it changes). Its items
-- and their evidence links can only change while it is a DRAFT.
CREATE FUNCTION "fca_guard_assessment"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'assessment % is % and cannot be deleted', OLD."id", OLD."status";
    END IF;
    RETURN OLD;
  END IF;
  IF OLD."status" IN ('APPROVED', 'SUPERSEDED') THEN
    IF OLD."status" = 'APPROVED' AND NEW."status" = 'SUPERSEDED'
       AND (to_jsonb(NEW) - 'status' - 'version' - 'updated_at') = (to_jsonb(OLD) - 'status' - 'version' - 'updated_at') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'assessment % is % and cannot be changed; create a revision', OLD."id", OLD."status";
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "assessments_guard" BEFORE UPDATE OR DELETE ON "assessments"
  FOR EACH ROW EXECUTE FUNCTION "fca_guard_assessment"();

CREATE FUNCTION "fca_guard_assessment_item"() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_status "AssessmentStatus";
  v_assessment uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN v_assessment := OLD."assessment_id"; ELSE v_assessment := NEW."assessment_id"; END IF;
  SELECT a."status" INTO v_status FROM "assessments" a WHERE a."id" = v_assessment;
  IF v_status IS NOT NULL AND v_status <> 'DRAFT' THEN
    RAISE EXCEPTION 'assessment % is % and its items cannot be changed', v_assessment, v_status;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "assessment_items_guard" BEFORE INSERT OR UPDATE OR DELETE ON "assessment_items"
  FOR EACH ROW EXECUTE FUNCTION "fca_guard_assessment_item"();

CREATE FUNCTION "fca_guard_assessment_item_evidence"() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_status "AssessmentStatus";
  v_item uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN v_item := OLD."assessment_item_id"; ELSE v_item := NEW."assessment_item_id"; END IF;
  SELECT a."status" INTO v_status
  FROM "assessment_items" i JOIN "assessments" a ON a."id" = i."assessment_id"
  WHERE i."id" = v_item;
  IF v_status IS NOT NULL AND v_status <> 'DRAFT' THEN
    RAISE EXCEPTION 'the assessment of this item is % and its evidence links cannot be changed', v_status;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "assessment_item_evidence_guard" BEFORE INSERT OR DELETE ON "assessment_item_evidence"
  FOR EACH ROW EXECUTE FUNCTION "fca_guard_assessment_item_evidence"();
