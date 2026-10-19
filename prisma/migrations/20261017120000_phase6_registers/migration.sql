-- CreateEnum
CREATE TYPE "RiskStatus" AS ENUM ('OPEN', 'IN_TREATMENT', 'ACCEPTED', 'TRANSFERRED', 'CLOSED');

-- CreateEnum
CREATE TYPE "RiskCategory" AS ENUM ('DATA_PRIVACY', 'CYBERSECURITY', 'OPERATIONAL', 'REGULATORY', 'THIRD_PARTY', 'PHYSICAL', 'REPUTATIONAL', 'FINANCIAL');

-- CreateEnum
CREATE TYPE "RiskAcceptanceDecision" AS ENUM ('ACCEPTED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "RopaActivityStatus" AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "LawfulBasisKind" AS ENUM ('CONSENT', 'CONTRACT', 'LEGAL_OBLIGATION', 'VITAL_INTERESTS', 'PUBLIC_TASK', 'LEGITIMATE_INTEREST');

-- CreateEnum
CREATE TYPE "LawfulBasisReviewStatus" AS ENUM ('DRAFT', 'UNDER_REVIEW', 'APPROVED');

-- CreateEnum
CREATE TYPE "RetentionTriggerEvent" AS ENUM ('CONTRACT_END', 'DATA_NO_LONGER_NEEDED', 'REGULATORY_PERIOD', 'SUBJECT_REQUEST', 'LAST_USE', 'OTHER');

-- CreateEnum
CREATE TYPE "DisposalTarget" AS ENUM ('EVIDENCE', 'ROPA_ACTIVITY', 'LAWFUL_BASIS_RECORD', 'RETENTION_RULE');

-- CreateTable
CREATE TABLE "classification_levels" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "rank" SMALLINT NOT NULL,
    "description" TEXT,
    "handling_guidance" TEXT,
    "owner_membership_id" UUID,
    "last_review_date" DATE,
    "next_review_date" DATE,
    "archived_at" TIMESTAMPTZ,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "classification_levels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ropa_activities" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "business_unit_id" UUID,
    "classification_level_id" UUID,
    "retention_rule_id" UUID,
    "purpose" TEXT,
    "data_subjects" TEXT,
    "personal_data_categories" TEXT,
    "recipients" TEXT,
    "processors" TEXT,
    "retention" TEXT,
    "international_transfers" TEXT,
    "transfer_countries" TEXT,
    "security_measures" TEXT,
    "owner_membership_id" UUID,
    "status" "RopaActivityStatus" NOT NULL DEFAULT 'DRAFT',
    "review_interval_days" INTEGER,
    "review_lead_days" INTEGER,
    "last_review_date" DATE,
    "next_review_date" DATE,
    "archived_at" TIMESTAMPTZ,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "ropa_activities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ropa_activity_evidence" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "activity_id" UUID NOT NULL,
    "evidence_id" UUID NOT NULL,
    "linked_by_user_id" UUID NOT NULL,
    "linked_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ropa_activity_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lawful_basis_records" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "purpose" TEXT NOT NULL,
    "basis" "LawfulBasisKind" NOT NULL,
    "framework_id" UUID,
    "requirement_id" UUID,
    "processing_activity_id" UUID,
    "justification" TEXT,
    "review_status" "LawfulBasisReviewStatus" NOT NULL DEFAULT 'DRAFT',
    "owner_membership_id" UUID,
    "review_interval_days" INTEGER,
    "review_lead_days" INTEGER,
    "last_review_date" DATE,
    "next_review_date" DATE,
    "archived_at" TIMESTAMPTZ,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "lawful_basis_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lawful_basis_evidence" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "record_id" UUID NOT NULL,
    "evidence_id" UUID NOT NULL,
    "linked_by_user_id" UUID NOT NULL,
    "linked_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lawful_basis_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "retention_rules" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "classification_level_id" UUID,
    "data_category" TEXT,
    "system_location" TEXT,
    "trigger_event" "RetentionTriggerEvent",
    "retention_period_days" INTEGER,
    "grace_period_days" INTEGER,
    "disposal_method" TEXT,
    "exceptions" TEXT,
    "owner_membership_id" UUID,
    "last_review_date" DATE,
    "next_review_date" DATE,
    "archived_at" TIMESTAMPTZ,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "retention_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "legal_holds" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "rule_id" UUID NOT NULL,
    "covered_kind" "DisposalTarget",
    "covered_record_id" UUID,
    "reason" TEXT NOT NULL,
    "placed_by_user_id" UUID NOT NULL,
    "placed_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "released_at" TIMESTAMPTZ,
    "released_by_user_id" UUID,
    "release_reason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "legal_holds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "retention_disposals" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "rule_id" UUID NOT NULL,
    "disposed_on" DATE NOT NULL,
    "note" TEXT NOT NULL,
    "item_count" INTEGER,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "retention_disposals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "risks" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "category" "RiskCategory",
    "governance_area_id" UUID,
    "requirement_id" UUID,
    "assessment_item_id" UUID,
    "business_unit_id" UUID,
    "framework_id" UUID,
    "status" "RiskStatus" NOT NULL DEFAULT 'OPEN',
    "owner_membership_id" UUID,
    "treatment_plan" TEXT,
    "inherent_likelihood" SMALLINT,
    "inherent_severity" SMALLINT,
    "inherent_score" SMALLINT,
    "inherent_level" "RiskLevel",
    "residual_likelihood" SMALLINT,
    "residual_severity" SMALLINT,
    "residual_score" SMALLINT,
    "residual_level" "RiskLevel",
    "methodology_id" TEXT NOT NULL DEFAULT 'risk_matrix_v1',
    "methodology_version" INTEGER NOT NULL DEFAULT 1,
    "review_by_date" DATE,
    "identified_on" DATE,
    "created_by_user_id" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "risks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "risk_acceptances" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "risk_id" UUID NOT NULL,
    "decision" "RiskAcceptanceDecision" NOT NULL,
    "rationale" TEXT NOT NULL,
    "decided_by_user_id" UUID NOT NULL,
    "decided_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_on" DATE,
    "review_on" DATE,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "risk_acceptances_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "classification_levels_organisation_id_archived_at_idx" ON "classification_levels"("organisation_id", "archived_at");

-- CreateIndex
CREATE UNIQUE INDEX "classification_levels_organisation_id_id_key" ON "classification_levels"("organisation_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "classification_levels_organisation_id_rank_key" ON "classification_levels"("organisation_id", "rank");

-- CreateIndex
CREATE INDEX "ropa_activities_organisation_id_status_idx" ON "ropa_activities"("organisation_id", "status");

-- CreateIndex
CREATE INDEX "ropa_activities_organisation_id_business_unit_id_idx" ON "ropa_activities"("organisation_id", "business_unit_id");

-- CreateIndex
CREATE INDEX "ropa_activities_organisation_id_classification_level_id_idx" ON "ropa_activities"("organisation_id", "classification_level_id");

-- CreateIndex
CREATE INDEX "ropa_activities_organisation_id_next_review_date_idx" ON "ropa_activities"("organisation_id", "next_review_date");

-- CreateIndex
CREATE UNIQUE INDEX "ropa_activities_organisation_id_id_key" ON "ropa_activities"("organisation_id", "id");

-- CreateIndex
CREATE INDEX "ropa_activity_evidence_organisation_id_evidence_id_idx" ON "ropa_activity_evidence"("organisation_id", "evidence_id");

-- CreateIndex
CREATE UNIQUE INDEX "ropa_activity_evidence_organisation_id_activity_id_evidence_key" ON "ropa_activity_evidence"("organisation_id", "activity_id", "evidence_id");

-- CreateIndex
CREATE INDEX "lawful_basis_records_organisation_id_basis_idx" ON "lawful_basis_records"("organisation_id", "basis");

-- CreateIndex
CREATE INDEX "lawful_basis_records_organisation_id_review_status_idx" ON "lawful_basis_records"("organisation_id", "review_status");

-- CreateIndex
CREATE INDEX "lawful_basis_records_organisation_id_processing_activity_id_idx" ON "lawful_basis_records"("organisation_id", "processing_activity_id");

-- CreateIndex
CREATE INDEX "lawful_basis_records_organisation_id_next_review_date_idx" ON "lawful_basis_records"("organisation_id", "next_review_date");

-- CreateIndex
CREATE UNIQUE INDEX "lawful_basis_records_organisation_id_id_key" ON "lawful_basis_records"("organisation_id", "id");

-- CreateIndex
CREATE INDEX "lawful_basis_evidence_organisation_id_evidence_id_idx" ON "lawful_basis_evidence"("organisation_id", "evidence_id");

-- CreateIndex
CREATE UNIQUE INDEX "lawful_basis_evidence_organisation_id_record_id_evidence_id_key" ON "lawful_basis_evidence"("organisation_id", "record_id", "evidence_id");

-- CreateIndex
CREATE INDEX "retention_rules_organisation_id_archived_at_idx" ON "retention_rules"("organisation_id", "archived_at");

-- CreateIndex
CREATE INDEX "retention_rules_organisation_id_classification_level_id_idx" ON "retention_rules"("organisation_id", "classification_level_id");

-- CreateIndex
CREATE INDEX "retention_rules_organisation_id_next_review_date_idx" ON "retention_rules"("organisation_id", "next_review_date");

-- CreateIndex
CREATE UNIQUE INDEX "retention_rules_organisation_id_id_key" ON "retention_rules"("organisation_id", "id");

-- CreateIndex
CREATE INDEX "legal_holds_organisation_id_rule_id_idx" ON "legal_holds"("organisation_id", "rule_id");

-- CreateIndex
CREATE INDEX "legal_holds_organisation_id_released_at_idx" ON "legal_holds"("organisation_id", "released_at");

-- CreateIndex
CREATE INDEX "legal_holds_organisation_id_covered_kind_covered_record_id_idx" ON "legal_holds"("organisation_id", "covered_kind", "covered_record_id");

-- CreateIndex
CREATE UNIQUE INDEX "legal_holds_organisation_id_id_key" ON "legal_holds"("organisation_id", "id");

-- CreateIndex
CREATE INDEX "retention_disposals_organisation_id_rule_id_disposed_on_idx" ON "retention_disposals"("organisation_id", "rule_id", "disposed_on" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "retention_disposals_organisation_id_id_key" ON "retention_disposals"("organisation_id", "id");

-- CreateIndex
CREATE INDEX "risks_organisation_id_status_idx" ON "risks"("organisation_id", "status");

-- CreateIndex
CREATE INDEX "risks_organisation_id_review_by_date_idx" ON "risks"("organisation_id", "review_by_date");

-- CreateIndex
CREATE INDEX "risks_organisation_id_business_unit_id_idx" ON "risks"("organisation_id", "business_unit_id");

-- CreateIndex
CREATE INDEX "risks_organisation_id_category_idx" ON "risks"("organisation_id", "category");

-- CreateIndex
CREATE UNIQUE INDEX "risks_organisation_id_id_key" ON "risks"("organisation_id", "id");

-- CreateIndex
CREATE INDEX "risk_acceptances_organisation_id_risk_id_decided_at_idx" ON "risk_acceptances"("organisation_id", "risk_id", "decided_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "risk_acceptances_organisation_id_id_key" ON "risk_acceptances"("organisation_id", "id");

-- AddForeignKey
ALTER TABLE "classification_levels" ADD CONSTRAINT "classification_levels_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "classification_levels" ADD CONSTRAINT "classification_levels_organisation_id_owner_membership_id_fkey" FOREIGN KEY ("organisation_id", "owner_membership_id") REFERENCES "memberships"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ropa_activities" ADD CONSTRAINT "ropa_activities_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ropa_activities" ADD CONSTRAINT "ropa_activities_organisation_id_business_unit_id_fkey" FOREIGN KEY ("organisation_id", "business_unit_id") REFERENCES "business_units"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ropa_activities" ADD CONSTRAINT "ropa_activities_organisation_id_classification_level_id_fkey" FOREIGN KEY ("organisation_id", "classification_level_id") REFERENCES "classification_levels"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ropa_activities" ADD CONSTRAINT "ropa_activities_organisation_id_retention_rule_id_fkey" FOREIGN KEY ("organisation_id", "retention_rule_id") REFERENCES "retention_rules"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ropa_activities" ADD CONSTRAINT "ropa_activities_organisation_id_owner_membership_id_fkey" FOREIGN KEY ("organisation_id", "owner_membership_id") REFERENCES "memberships"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ropa_activity_evidence" ADD CONSTRAINT "ropa_activity_evidence_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ropa_activity_evidence" ADD CONSTRAINT "ropa_activity_evidence_organisation_id_activity_id_fkey" FOREIGN KEY ("organisation_id", "activity_id") REFERENCES "ropa_activities"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ropa_activity_evidence" ADD CONSTRAINT "ropa_activity_evidence_organisation_id_evidence_id_fkey" FOREIGN KEY ("organisation_id", "evidence_id") REFERENCES "evidence"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ropa_activity_evidence" ADD CONSTRAINT "ropa_activity_evidence_linked_by_user_id_fkey" FOREIGN KEY ("linked_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lawful_basis_records" ADD CONSTRAINT "lawful_basis_records_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lawful_basis_records" ADD CONSTRAINT "lawful_basis_records_framework_id_fkey" FOREIGN KEY ("framework_id") REFERENCES "frameworks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lawful_basis_records" ADD CONSTRAINT "lawful_basis_records_requirement_id_fkey" FOREIGN KEY ("requirement_id") REFERENCES "requirements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lawful_basis_records" ADD CONSTRAINT "lawful_basis_records_organisation_id_processing_activity_i_fkey" FOREIGN KEY ("organisation_id", "processing_activity_id") REFERENCES "ropa_activities"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lawful_basis_records" ADD CONSTRAINT "lawful_basis_records_organisation_id_owner_membership_id_fkey" FOREIGN KEY ("organisation_id", "owner_membership_id") REFERENCES "memberships"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lawful_basis_evidence" ADD CONSTRAINT "lawful_basis_evidence_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lawful_basis_evidence" ADD CONSTRAINT "lawful_basis_evidence_organisation_id_record_id_fkey" FOREIGN KEY ("organisation_id", "record_id") REFERENCES "lawful_basis_records"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lawful_basis_evidence" ADD CONSTRAINT "lawful_basis_evidence_organisation_id_evidence_id_fkey" FOREIGN KEY ("organisation_id", "evidence_id") REFERENCES "evidence"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lawful_basis_evidence" ADD CONSTRAINT "lawful_basis_evidence_linked_by_user_id_fkey" FOREIGN KEY ("linked_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "retention_rules" ADD CONSTRAINT "retention_rules_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "retention_rules" ADD CONSTRAINT "retention_rules_organisation_id_classification_level_id_fkey" FOREIGN KEY ("organisation_id", "classification_level_id") REFERENCES "classification_levels"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "retention_rules" ADD CONSTRAINT "retention_rules_organisation_id_owner_membership_id_fkey" FOREIGN KEY ("organisation_id", "owner_membership_id") REFERENCES "memberships"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "legal_holds" ADD CONSTRAINT "legal_holds_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "legal_holds" ADD CONSTRAINT "legal_holds_organisation_id_rule_id_fkey" FOREIGN KEY ("organisation_id", "rule_id") REFERENCES "retention_rules"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "legal_holds" ADD CONSTRAINT "legal_holds_placed_by_user_id_fkey" FOREIGN KEY ("placed_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "legal_holds" ADD CONSTRAINT "legal_holds_released_by_user_id_fkey" FOREIGN KEY ("released_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "retention_disposals" ADD CONSTRAINT "retention_disposals_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "retention_disposals" ADD CONSTRAINT "retention_disposals_organisation_id_rule_id_fkey" FOREIGN KEY ("organisation_id", "rule_id") REFERENCES "retention_rules"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "retention_disposals" ADD CONSTRAINT "retention_disposals_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "risks" ADD CONSTRAINT "risks_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "risks" ADD CONSTRAINT "risks_organisation_id_governance_area_id_fkey" FOREIGN KEY ("organisation_id", "governance_area_id") REFERENCES "governance_areas"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "risks" ADD CONSTRAINT "risks_requirement_id_fkey" FOREIGN KEY ("requirement_id") REFERENCES "requirements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "risks" ADD CONSTRAINT "risks_organisation_id_assessment_item_id_fkey" FOREIGN KEY ("organisation_id", "assessment_item_id") REFERENCES "assessment_items"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "risks" ADD CONSTRAINT "risks_organisation_id_business_unit_id_fkey" FOREIGN KEY ("organisation_id", "business_unit_id") REFERENCES "business_units"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "risks" ADD CONSTRAINT "risks_framework_id_fkey" FOREIGN KEY ("framework_id") REFERENCES "frameworks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "risks" ADD CONSTRAINT "risks_organisation_id_owner_membership_id_fkey" FOREIGN KEY ("organisation_id", "owner_membership_id") REFERENCES "memberships"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "risks" ADD CONSTRAINT "risks_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "risk_acceptances" ADD CONSTRAINT "risk_acceptances_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "risk_acceptances" ADD CONSTRAINT "risk_acceptances_organisation_id_risk_id_fkey" FOREIGN KEY ("organisation_id", "risk_id") REFERENCES "risks"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "risk_acceptances" ADD CONSTRAINT "risk_acceptances_decided_by_user_id_fkey" FOREIGN KEY ("decided_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;




-- ---------------------------------------------------------------------------------------------
-- Hand-written additions (not generated by Prisma; they are not part of schema.prisma).
-- ---------------------------------------------------------------------------------------------

-- Impossible rows are rejected by the database, not only by the service. Every length below is the
-- same bound the request DTOs enforce, so a client that bypasses the API still cannot store junk.

ALTER TABLE "classification_levels" ADD CONSTRAINT "classification_levels_check" CHECK (
  length(btrim("name")) BETWEEN 1 AND 60
  AND "rank" BETWEEN 1 AND 20
  AND ("description" IS NULL OR length("description") <= 500)
  AND ("handling_guidance" IS NULL OR length("handling_guidance") <= 2000)
  AND ("last_review_date" IS NULL OR "next_review_date" IS NULL OR "next_review_date" > "last_review_date")
);
-- Two live levels cannot share a name; an archived one frees the name but never its rank.
CREATE UNIQUE INDEX "classification_levels_active_name_key" ON "classification_levels" (
  "organisation_id", lower("name")
) WHERE "archived_at" IS NULL;

ALTER TABLE "ropa_activities" ADD CONSTRAINT "ropa_activities_check" CHECK (
  length(btrim("name")) BETWEEN 1 AND 120
  AND ("purpose" IS NULL OR length("purpose") <= 2000)
  AND ("data_subjects" IS NULL OR length("data_subjects") <= 2000)
  AND ("personal_data_categories" IS NULL OR length("personal_data_categories") <= 2000)
  AND ("recipients" IS NULL OR length("recipients") <= 2000)
  AND ("processors" IS NULL OR length("processors") <= 2000)
  AND ("retention" IS NULL OR length("retention") <= 2000)
  AND ("international_transfers" IS NULL OR length("international_transfers") <= 2000)
  AND ("transfer_countries" IS NULL OR length("transfer_countries") <= 2000)
  AND ("security_measures" IS NULL OR length("security_measures") <= 2000)
  -- the archive flag is the status, not a second source of truth about it
  AND ("status" = 'ARCHIVED') = ("archived_at" IS NOT NULL)
  AND ("review_interval_days" IS NULL OR "review_interval_days" BETWEEN 1 AND 3660)
  AND ("review_lead_days" IS NULL OR "review_lead_days" BETWEEN 0 AND 366)
  AND ("last_review_date" IS NULL OR "next_review_date" IS NULL OR "next_review_date" > "last_review_date")
);

ALTER TABLE "lawful_basis_records" ADD CONSTRAINT "lawful_basis_records_check" CHECK (
  length(btrim("purpose")) BETWEEN 1 AND 200
  AND ("justification" IS NULL OR length("justification") <= 4000)
  -- an approved basis has to say why it is the right one
  AND ("review_status" <> 'APPROVED' OR length(btrim("justification")) >= 3)
  AND ("review_interval_days" IS NULL OR "review_interval_days" BETWEEN 1 AND 3660)
  AND ("review_lead_days" IS NULL OR "review_lead_days" BETWEEN 0 AND 366)
  AND ("last_review_date" IS NULL OR "next_review_date" IS NULL OR "next_review_date" > "last_review_date")
);

ALTER TABLE "retention_rules" ADD CONSTRAINT "retention_rules_check" CHECK (
  length(btrim("name")) BETWEEN 1 AND 120
  AND ("data_category" IS NULL OR length("data_category") <= 500)
  AND ("system_location" IS NULL OR length("system_location") <= 500)
  AND ("disposal_method" IS NULL OR length("disposal_method") <= 500)
  AND ("exceptions" IS NULL OR length("exceptions") <= 2000)
  AND ("retention_period_days" IS NULL OR "retention_period_days" BETWEEN 1 AND 36500)
  AND ("grace_period_days" IS NULL OR ("grace_period_days" BETWEEN 0 AND 3660 AND "retention_period_days" IS NOT NULL))
  AND ("last_review_date" IS NULL OR "next_review_date" IS NULL OR "next_review_date" > "last_review_date")
);

ALTER TABLE "legal_holds" ADD CONSTRAINT "legal_holds_check" CHECK (
  length(btrim("reason")) BETWEEN 3 AND 1000
  -- a hold names one record, or it is blanket over the whole rule: never half of each
  AND ("covered_kind" IS NULL) = ("covered_record_id" IS NULL)
  AND ("released_at" IS NULL) = ("released_by_user_id" IS NULL)
  AND ("released_at" IS NULL OR "released_at" >= "placed_at")
  AND ("released_at" IS NULL OR length(btrim("release_reason")) >= 3)
);

ALTER TABLE "retention_disposals" ADD CONSTRAINT "retention_disposals_check" CHECK (
  length(btrim("note")) BETWEEN 3 AND 2000
  AND ("item_count" IS NULL OR "item_count" > 0)
);

ALTER TABLE "risk_acceptances" ADD CONSTRAINT "risk_acceptances_check" CHECK (
  length(btrim("rationale")) BETWEEN 3 AND 1000
  AND ("expires_on" IS NULL OR "review_on" IS NULL OR "review_on" <= "expires_on")
);

ALTER TABLE "risks" ADD CONSTRAINT "risks_check" CHECK (
  length(btrim("title")) BETWEEN 1 AND 200
  AND ("description" IS NULL OR length("description") <= 4000)
  AND ("treatment_plan" IS NULL OR length("treatment_plan") <= 4000)
  AND ("inherent_likelihood" IS NULL OR "inherent_likelihood" BETWEEN 1 AND 5)
  AND ("inherent_severity" IS NULL OR "inherent_severity" BETWEEN 1 AND 5)
  AND ("residual_likelihood" IS NULL OR "residual_likelihood" BETWEEN 1 AND 5)
  AND ("residual_severity" IS NULL OR "residual_severity" BETWEEN 1 AND 5)
  -- only one scoring methodology exists in this phase, and the row records which one scored it
  AND "methodology_id" = 'risk_matrix_v1'
  AND "methodology_version" >= 1
  -- the score and the band are derived from the two factors and always agree with them
  AND (("inherent_likelihood" IS NULL OR "inherent_severity" IS NULL) = ("inherent_score" IS NULL))
  AND ("inherent_score" IS NULL OR "inherent_score" = "inherent_likelihood" * "inherent_severity")
  AND (("inherent_score" IS NULL) = ("inherent_level" IS NULL))
  AND ("inherent_level" IS NULL OR "inherent_level" = (
    CASE
      WHEN "inherent_score" <= 5 THEN 'LOW'
      WHEN "inherent_score" <= 11 THEN 'MEDIUM'
      WHEN "inherent_score" <= 19 THEN 'HIGH'
      ELSE 'CRITICAL'
    END
  )::"RiskLevel")
  AND (("residual_likelihood" IS NULL OR "residual_severity" IS NULL) = ("residual_score" IS NULL))
  AND ("residual_score" IS NULL OR "residual_score" = "residual_likelihood" * "residual_severity")
  AND (("residual_score" IS NULL) = ("residual_level" IS NULL))
  AND ("residual_level" IS NULL OR "residual_level" = (
    CASE
      WHEN "residual_score" <= 5 THEN 'LOW'
      WHEN "residual_score" <= 11 THEN 'MEDIUM'
      WHEN "residual_score" <= 19 THEN 'HIGH'
      ELSE 'CRITICAL'
    END
  )::"RiskLevel")
  -- controls can only reduce a risk, never inflate it, and there is nothing residual before something inherent
  AND ("inherent_score" IS NOT NULL OR "residual_score" IS NULL)
  AND ("inherent_likelihood" IS NULL OR "residual_likelihood" IS NULL OR "residual_likelihood" <= "inherent_likelihood")
  AND ("inherent_severity" IS NULL OR "residual_severity" IS NULL OR "residual_severity" <= "inherent_severity")
);

-- Row-level security for every new tenant table (ADR-0004; the helper comes from the 2c migration).
SELECT "fca_enable_tenant_rls"('classification_levels');
SELECT "fca_enable_tenant_rls"('ropa_activities');
SELECT "fca_enable_tenant_rls"('ropa_activity_evidence');
SELECT "fca_enable_tenant_rls"('lawful_basis_records');
SELECT "fca_enable_tenant_rls"('lawful_basis_evidence');
SELECT "fca_enable_tenant_rls"('retention_rules');
SELECT "fca_enable_tenant_rls"('legal_holds');
SELECT "fca_enable_tenant_rls"('retention_disposals');
SELECT "fca_enable_tenant_rls"('risks');
SELECT "fca_enable_tenant_rls"('risk_acceptances');

-- The acceptance ledger and the disposal log are evidence: append-only, like the audit trail. A withdrawn
-- acceptance is a new row, and a mistake is corrected by another row, never by rewriting history.
CREATE FUNCTION "risk_acceptances_reject_mutation"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'risk_acceptances is append-only (% is not allowed)', TG_OP;
END
$$;
CREATE TRIGGER "risk_acceptances_no_update_delete"
  BEFORE UPDATE OR DELETE ON "risk_acceptances"
  FOR EACH ROW EXECUTE FUNCTION "risk_acceptances_reject_mutation"();

CREATE FUNCTION "retention_disposals_reject_mutation"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'retention_disposals is append-only (% is not allowed)', TG_OP;
END
$$;
CREATE TRIGGER "retention_disposals_no_update_delete"
  BEFORE UPDATE OR DELETE ON "retention_disposals"
  FOR EACH ROW EXECUTE FUNCTION "retention_disposals_reject_mutation"();

-- A legal hold is placed and later released; it is never edited afterwards and never deleted. The only
-- writable columns are the release fields (and the optimistic-lock counter that comes with them).
CREATE FUNCTION "fca_guard_legal_hold"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'legal hold % cannot be deleted; release it instead', OLD."id";
  END IF;
  IF (to_jsonb(NEW) - 'released_at' - 'released_by_user_id' - 'release_reason' - 'version')
     <> (to_jsonb(OLD) - 'released_at' - 'released_by_user_id' - 'release_reason' - 'version') THEN
    RAISE EXCEPTION 'legal hold % is immutable; only its release may be recorded', OLD."id";
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "legal_holds_guard" BEFORE UPDATE OR DELETE ON "legal_holds"
  FOR EACH ROW EXECUTE FUNCTION "fca_guard_legal_hold"();

-- Nothing under a live hold can be disposed of. The service answers 409 LEGAL_HOLD_ACTIVE first; this is
-- the backstop that still holds if a future code path forgets to ask. A hold either names one record
-- (covered_kind + covered_record_id) or is blanket over its rule and everything that points at that rule.
-- Row-level security already limits the scan to the caller's organisation (ADR-0004), so no tenant
-- predicate is repeated here.
CREATE FUNCTION "fca_hold_covers"(p_kind "DisposalTarget", p_record_id uuid, p_record_rule_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM "legal_holds" h
    WHERE h."released_at" IS NULL
      AND (
        (h."covered_kind" = p_kind AND h."covered_record_id" = p_record_id)
        -- blanket: only records that actually belong to the held rule are covered by it
        OR (h."covered_kind" IS NULL AND p_record_rule_id IS NOT NULL AND h."rule_id" = p_record_rule_id)
      )
  )
$$;

CREATE FUNCTION "fca_guard_ropa_activity_under_hold"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF "fca_hold_covers"('ROPA_ACTIVITY', OLD."id", OLD."retention_rule_id") THEN
    RAISE EXCEPTION 'RoPA activity % is under a legal hold and cannot be deleted', OLD."id";
  END IF;
  RETURN OLD;
END
$$;
CREATE TRIGGER "ropa_activities_under_hold_guard" BEFORE DELETE ON "ropa_activities"
  FOR EACH ROW EXECUTE FUNCTION "fca_guard_ropa_activity_under_hold"();

CREATE FUNCTION "fca_guard_lawful_basis_under_hold"() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_rule uuid;
BEGIN
  SELECT r."retention_rule_id" INTO v_rule
  FROM "ropa_activities" r WHERE r."id" = OLD."processing_activity_id";
  IF "fca_hold_covers"('LAWFUL_BASIS_RECORD', OLD."id", v_rule) THEN
    RAISE EXCEPTION 'lawful basis record % is under a legal hold and cannot be deleted', OLD."id";
  END IF;
  RETURN OLD;
END
$$;
CREATE TRIGGER "lawful_basis_records_under_hold_guard" BEFORE DELETE ON "lawful_basis_records"
  FOR EACH ROW EXECUTE FUNCTION "fca_guard_lawful_basis_under_hold"();

CREATE FUNCTION "fca_guard_evidence_under_hold"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF "fca_hold_covers"('EVIDENCE', OLD."id", NULL) THEN
    RAISE EXCEPTION 'evidence % is under a legal hold and cannot be deleted', OLD."id";
  END IF;
  RETURN OLD;
END
$$;
CREATE TRIGGER "evidence_under_hold_guard" BEFORE DELETE ON "evidence"
  FOR EACH ROW EXECUTE FUNCTION "fca_guard_evidence_under_hold"();

CREATE FUNCTION "fca_guard_retention_rule_under_hold"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "legal_holds" h
    WHERE h."released_at" IS NULL
      AND h."rule_id" = OLD."id"
      AND (h."covered_kind" IS NULL OR h."covered_kind" = 'RETENTION_RULE')
      AND (h."covered_record_id" IS NULL OR h."covered_record_id" = OLD."id")
  ) THEN
    RAISE EXCEPTION 'retention rule % is under a legal hold and cannot be deleted', OLD."id";
  END IF;
  RETURN OLD;
END
$$;
CREATE TRIGGER "retention_rules_under_hold_guard" BEFORE DELETE ON "retention_rules"
  FOR EACH ROW EXECUTE FUNCTION "fca_guard_retention_rule_under_hold"();

-- A rule-wide disposal cannot be logged while any hold on that rule is live, even a hold on a single
-- record: the note would claim disposal of something that must be preserved.
CREATE FUNCTION "fca_guard_retention_disposal"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "legal_holds" h
    WHERE h."released_at" IS NULL
      AND h."organisation_id" = NEW."organisation_id"
      AND h."rule_id" = NEW."rule_id"
  ) THEN
    RAISE EXCEPTION 'retention rule % is under a legal hold, so no disposal may be recorded against it', NEW."rule_id";
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "retention_disposals_hold_guard" BEFORE INSERT ON "retention_disposals"
  FOR EACH ROW EXECUTE FUNCTION "fca_guard_retention_disposal"();

-- ACCEPTED is a claim about the ledger, so the ledger has to agree with it: the newest acceptance row
-- must be an acceptance. Refusing the pair is what stops a status flip from quietly accepting a risk.
CREATE FUNCTION "fca_guard_risk_acceptance"() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_decision "RiskAcceptanceDecision";
BEGIN
  IF NEW."status" <> 'ACCEPTED' THEN
    RETURN NEW;
  END IF;
  SELECT a."decision" INTO v_decision
  FROM "risk_acceptances" a
  WHERE a."risk_id" = NEW."id"
  ORDER BY a."decided_at" DESC, a."id" DESC
  LIMIT 1;
  IF v_decision IS DISTINCT FROM 'ACCEPTED' THEN
    RAISE EXCEPTION 'risk % cannot be ACCEPTED without an acceptance in force', NEW."id";
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "risks_acceptance_guard" BEFORE INSERT OR UPDATE ON "risks"
  FOR EACH ROW EXECUTE FUNCTION "fca_guard_risk_acceptance"();
