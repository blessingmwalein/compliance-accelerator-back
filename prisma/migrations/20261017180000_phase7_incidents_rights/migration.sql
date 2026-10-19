-- Phase 7: incidents and rights (DSAR tracker, breach registry, evidence repository, reminders).
--
-- Hand-authored, like the Phase 6 registers: the CHECKs and triggers below carry rules the schema language
-- cannot express, so `prisma migrate dev` would silently drop them. Applied by the owner with a NON-POOLED
-- DIRECT_URL (`npm run db:migrate:deploy`), never by the agent.
--
-- Index and constraint names are written out instead of left to Postgres, and long ones are shortened to
-- stay inside its 63-character identifier limit (the table name `breach_notification_decisions` alone is
-- half of it).

-- CreateEnum
CREATE TYPE "DsarRequestType" AS ENUM ('ACCESS', 'RECTIFICATION', 'ERASURE', 'RESTRICTION', 'PORTABILITY', 'OBJECTION', 'OTHER');

-- CreateEnum
CREATE TYPE "DsarStatus" AS ENUM ('RECEIVED', 'VERIFYING', 'IN_PROGRESS', 'ON_HOLD', 'COMPLETED', 'REFUSED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "DsarIdentityState" AS ENUM ('NOT_STARTED', 'REQUESTED', 'VERIFIED', 'FAILED');

-- CreateEnum
CREATE TYPE "DsarCommunicationKind" AS ENUM ('OUTBOUND', 'INBOUND', 'NOTE');

-- CreateEnum
CREATE TYPE "BreachStatus" AS ENUM ('RECORDED', 'INVESTIGATING', 'REMEDIATING', 'CLOSED');

-- CreateEnum
CREATE TYPE "BreachChronologyKind" AS ENUM ('DETECTION', 'INVESTIGATION', 'CONTAINMENT', 'IMPACT', 'REMEDIATION', 'NOTE');

-- CreateEnum
CREATE TYPE "BreachNotificationState" AS ENUM ('UNDECIDED', 'NOTIFICATION_REQUIRED', 'NOT_REQUIRED');

-- CreateEnum
CREATE TYPE "BreachNotificationDecisionKind" AS ENUM ('REQUIRED', 'NOT_REQUIRED');

-- CreateEnum
CREATE TYPE "AlertKind" AS ENUM ('DSAR_DUE_SOON', 'DSAR_OVERDUE', 'BREACH_RECORDED', 'BREACH_ASSESSMENT_DUE', 'BREACH_NOTIFICATION_DUE', 'REMINDER_DUE_SOON', 'REMINDER_OVERDUE');

-- CreateEnum
CREATE TYPE "AlertStatus" AS ENUM ('QUEUED', 'SENT', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "AlertSkipReason" AS ENUM ('NO_RECIPIENT', 'PREFERENCE_OFF', 'STALE_DEADLINE', 'ALREADY_HANDLED');

-- CreateEnum
CREATE TYPE "EvidenceReviewStatus" AS ENUM ('UNREVIEWED', 'UNDER_REVIEW', 'ACCEPTED', 'REJECTED');

-- CreateEnum
CREATE TYPE "EvidenceScanState" AS ENUM ('NOT_SCANNED', 'CLEAN', 'INFECTED', 'UNABLE_TO_SCAN');

-- CreateEnum
CREATE TYPE "ReminderStatus" AS ENUM ('PENDING', 'DONE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ReminderSourceKind" AS ENUM ('DSAR_REQUEST', 'BREACH', 'EVIDENCE', 'RISK', 'REMEDIATION_TASK', 'OTHER');

-- CreateTable: the organisation's deadline choices. One row at most, every column nullable: a NULL is
-- "this organisation has not decided", which the endpoints report as `not_configured` instead of a date.
CREATE TABLE "deadline_policies" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "dsar_response_days" INTEGER,
    "dsar_extension_days" INTEGER,
    "dsar_extension_limit" INTEGER,
    "breach_assessment_days" INTEGER,
    "breach_notification_days" INTEGER,
    "alert_lead_days" INTEGER,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "deadline_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dsar_requests" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "request_type" "DsarRequestType" NOT NULL,
    "summary" TEXT,
    "subject_name" TEXT,
    "subject_email" TEXT,
    "received_on" DATE NOT NULL,
    "status" "DsarStatus" NOT NULL DEFAULT 'RECEIVED',
    "business_unit_id" UUID,
    "owner_membership_id" UUID,
    "identity_state" "DsarIdentityState" NOT NULL DEFAULT 'NOT_STARTED',
    "identity_verified_on" DATE,
    "identity_verified_by_user_id" UUID,
    "identity_note" TEXT,
    "policy_id" UUID,
    "response_days" INTEGER,
    "base_due_on" DATE,
    "extension_days" INTEGER NOT NULL DEFAULT 0,
    "extension_count" INTEGER NOT NULL DEFAULT 0,
    "due_on" DATE,
    "closure_note" TEXT,
    "completed_on" DATE,
    "completed_by_user_id" UUID,
    "created_by_user_id" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "dsar_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dsar_extensions" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "dsar_request_id" UUID NOT NULL,
    "days" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "previous_due_on" DATE NOT NULL,
    "new_due_on" DATE NOT NULL,
    "decided_by_user_id" UUID NOT NULL,
    "decided_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dsar_extensions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dsar_communications" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "dsar_request_id" UUID NOT NULL,
    "kind" "DsarCommunicationKind" NOT NULL,
    "occurred_on" DATE NOT NULL,
    "note" TEXT NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dsar_communications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dsar_request_evidence" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "dsar_request_id" UUID NOT NULL,
    "evidence_id" UUID NOT NULL,
    "linked_by_user_id" UUID NOT NULL,
    "linked_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dsar_request_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "breaches" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" "BreachStatus" NOT NULL DEFAULT 'RECORDED',
    "detected_on" DATE NOT NULL,
    "affected_data" TEXT,
    "affected_subject_count" INTEGER,
    "severity" "RiskLevel",
    "impact" TEXT,
    "business_unit_id" UUID,
    "owner_membership_id" UUID,
    "policy_id" UUID,
    "assessment_days" INTEGER,
    "notification_days" INTEGER,
    "assessment_due_on" DATE,
    "notification_due_on" DATE,
    "notification_state" "BreachNotificationState" NOT NULL DEFAULT 'UNDECIDED',
    "closed_on" DATE,
    "closed_by_user_id" UUID,
    "closure_note" TEXT,
    "created_by_user_id" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "breaches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "breach_chronology_entries" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "breach_id" UUID NOT NULL,
    "kind" "BreachChronologyKind" NOT NULL,
    "occurred_on" DATE NOT NULL,
    "note" TEXT NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "breach_chronology_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "breach_notification_decisions" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "breach_id" UUID NOT NULL,
    "decision" "BreachNotificationDecisionKind" NOT NULL,
    "regulator_contact_id" UUID,
    "authority_name" TEXT,
    "target_date" DATE,
    "reason" TEXT NOT NULL,
    "decided_by_user_id" UUID NOT NULL,
    "decided_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "breach_notification_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "breach_evidence" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "breach_id" UUID NOT NULL,
    "evidence_id" UUID NOT NULL,
    "linked_by_user_id" UUID NOT NULL,
    "linked_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "breach_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable: one row per stored file of an evidence record. The five columns the Phase 5 `evidence`
-- table carried about the file move here, where a new upload is a new row instead of a lost history.
CREATE TABLE "evidence_versions" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "evidence_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "original_filename" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "note" TEXT,
    "uploaded_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "evidence_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reminders" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "note" TEXT,
    "due_on" DATE NOT NULL,
    "lead_days" INTEGER,
    "status" "ReminderStatus" NOT NULL DEFAULT 'PENDING',
    "assignee_membership_id" UUID,
    "source_kind" "ReminderSourceKind",
    "source_id" UUID,
    "source_label" TEXT,
    "created_by_user_id" UUID NOT NULL,
    "completed_on" TIMESTAMPTZ,
    "completed_by_user_id" UUID,
    "cancelled_on" TIMESTAMPTZ,
    "cancelled_by_user_id" UUID,
    "cancel_reason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "reminders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reminder_preferences" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "membership_id" UUID NOT NULL,
    "email_due_soon" BOOLEAN NOT NULL DEFAULT true,
    "email_overdue" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "reminder_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alert_deliveries" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "kind" "AlertKind" NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "status" "AlertStatus" NOT NULL DEFAULT 'QUEUED',
    "recipient_address" TEXT,
    "recipient_label" TEXT,
    "due_on" DATE,
    "skip_reason" "AlertSkipReason",
    "last_error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "sent_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "dsar_request_id" UUID,
    "breach_id" UUID,
    "reminder_id" UUID,

    CONSTRAINT "alert_deliveries_pkey" PRIMARY KEY ("id")
);

-- AlterTable: the evidence record becomes what a person browses and owns; the file moves to the version rows.
ALTER TABLE "evidence"
    ADD COLUMN "current_version" INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN "owner_membership_id" UUID,
    ADD COLUMN "review_status" "EvidenceReviewStatus" NOT NULL DEFAULT 'UNREVIEWED',
    ADD COLUMN "reviewed_by_user_id" UUID,
    ADD COLUMN "review_note" TEXT,
    ADD COLUMN "last_review_date" DATE,
    ADD COLUMN "next_review_date" DATE,
    ADD COLUMN "scan_state" "EvidenceScanState" NOT NULL DEFAULT 'NOT_SCANNED',
    ADD COLUMN "scanned_on" DATE,
    ADD COLUMN "scan_note" TEXT,
    ADD COLUMN "attested_by_user_id" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "deadline_policies_organisation_id_key" ON "deadline_policies"("organisation_id");

-- CreateIndex
CREATE UNIQUE INDEX "deadline_policies_organisation_id_id_key" ON "deadline_policies"("organisation_id", "id");

-- CreateIndex
CREATE INDEX "dsar_requests_organisation_id_status_idx" ON "dsar_requests"("organisation_id", "status");

-- CreateIndex
CREATE INDEX "dsar_requests_organisation_id_due_on_idx" ON "dsar_requests"("organisation_id", "due_on");

-- CreateIndex
CREATE INDEX "dsar_requests_organisation_id_received_on_idx" ON "dsar_requests"("organisation_id", "received_on" DESC);

-- CreateIndex
CREATE INDEX "dsar_requests_organisation_id_owner_membership_id_idx" ON "dsar_requests"("organisation_id", "owner_membership_id");

-- CreateIndex
CREATE INDEX "dsar_requests_organisation_id_request_type_idx" ON "dsar_requests"("organisation_id", "request_type");

-- CreateIndex
CREATE UNIQUE INDEX "dsar_requests_organisation_id_id_key" ON "dsar_requests"("organisation_id", "id");

-- CreateIndex
CREATE INDEX "dsar_extensions_organisation_id_dsar_request_id_idx" ON "dsar_extensions"("organisation_id", "dsar_request_id");

-- CreateIndex
CREATE UNIQUE INDEX "dsar_extensions_organisation_id_id_key" ON "dsar_extensions"("organisation_id", "id");

-- CreateIndex
CREATE INDEX "dsar_communications_organisation_id_dsar_request_id_idx" ON "dsar_communications"("organisation_id", "dsar_request_id");

-- CreateIndex
CREATE UNIQUE INDEX "dsar_communications_organisation_id_id_key" ON "dsar_communications"("organisation_id", "id");

-- CreateIndex
CREATE INDEX "dsar_request_evidence_organisation_id_evidence_id_idx" ON "dsar_request_evidence"("organisation_id", "evidence_id");

-- CreateIndex
CREATE UNIQUE INDEX "dsar_request_evidence_org_request_evidence_key" ON "dsar_request_evidence"("organisation_id", "dsar_request_id", "evidence_id");

-- CreateIndex
CREATE UNIQUE INDEX "dsar_request_evidence_organisation_id_id_key" ON "dsar_request_evidence"("organisation_id", "id");

-- CreateIndex
CREATE INDEX "breaches_organisation_id_status_idx" ON "breaches"("organisation_id", "status");

-- CreateIndex
CREATE INDEX "breaches_organisation_id_detected_on_idx" ON "breaches"("organisation_id", "detected_on" DESC);

-- CreateIndex
CREATE INDEX "breaches_organisation_id_notification_due_on_idx" ON "breaches"("organisation_id", "notification_due_on");

-- CreateIndex
CREATE INDEX "breaches_organisation_id_owner_membership_id_idx" ON "breaches"("organisation_id", "owner_membership_id");

-- CreateIndex
CREATE UNIQUE INDEX "breaches_organisation_id_id_key" ON "breaches"("organisation_id", "id");

-- CreateIndex
CREATE INDEX "breach_chronology_entries_organisation_id_breach_id_idx" ON "breach_chronology_entries"("organisation_id", "breach_id");

-- CreateIndex
CREATE UNIQUE INDEX "breach_chronology_entries_organisation_id_id_key" ON "breach_chronology_entries"("organisation_id", "id");

-- CreateIndex
CREATE INDEX "breach_decisions_organisation_id_breach_id_decided_at_idx" ON "breach_notification_decisions"("organisation_id", "breach_id", "decided_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "breach_notification_decisions_organisation_id_id_key" ON "breach_notification_decisions"("organisation_id", "id");

-- CreateIndex
CREATE INDEX "breach_evidence_organisation_id_evidence_id_idx" ON "breach_evidence"("organisation_id", "evidence_id");

-- CreateIndex
CREATE UNIQUE INDEX "breach_evidence_organisation_id_breach_id_evidence_key" ON "breach_evidence"("organisation_id", "breach_id", "evidence_id");

-- CreateIndex
CREATE UNIQUE INDEX "breach_evidence_organisation_id_id_key" ON "breach_evidence"("organisation_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "evidence_versions_organisation_id_evidence_id_number_key" ON "evidence_versions"("organisation_id", "evidence_id", "number");

-- CreateIndex
CREATE INDEX "evidence_versions_organisation_id_evidence_id_idx" ON "evidence_versions"("organisation_id", "evidence_id");

-- CreateIndex
CREATE UNIQUE INDEX "evidence_versions_organisation_id_id_key" ON "evidence_versions"("organisation_id", "id");

-- CreateIndex
CREATE INDEX "evidence_organisation_id_review_status_idx" ON "evidence"("organisation_id", "review_status");

-- CreateIndex
CREATE INDEX "evidence_organisation_id_owner_membership_id_idx" ON "evidence"("organisation_id", "owner_membership_id");

-- CreateIndex
CREATE INDEX "evidence_organisation_id_next_review_date_idx" ON "evidence"("organisation_id", "next_review_date");

-- CreateIndex
CREATE INDEX "reminders_organisation_id_status_due_on_idx" ON "reminders"("organisation_id", "status", "due_on");

-- CreateIndex
CREATE INDEX "reminders_organisation_id_assignee_membership_id_idx" ON "reminders"("organisation_id", "assignee_membership_id");

-- CreateIndex
CREATE INDEX "reminders_organisation_id_due_on_idx" ON "reminders"("organisation_id", "due_on");

-- CreateIndex
CREATE UNIQUE INDEX "reminders_organisation_id_id_key" ON "reminders"("organisation_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "reminder_preferences_organisation_id_membership_id_key" ON "reminder_preferences"("organisation_id", "membership_id");

-- CreateIndex
CREATE UNIQUE INDEX "reminder_preferences_organisation_id_id_key" ON "reminder_preferences"("organisation_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "alert_deliveries_organisation_id_dedupe_key" ON "alert_deliveries"("organisation_id", "dedupe_key");

-- CreateIndex
CREATE INDEX "alert_deliveries_organisation_id_kind_created_at_idx" ON "alert_deliveries"("organisation_id", "kind", "created_at" DESC);

-- CreateIndex
CREATE INDEX "alert_deliveries_organisation_id_dsar_request_id_idx" ON "alert_deliveries"("organisation_id", "dsar_request_id");

-- CreateIndex
CREATE INDEX "alert_deliveries_organisation_id_breach_id_idx" ON "alert_deliveries"("organisation_id", "breach_id");

-- CreateIndex
CREATE INDEX "alert_deliveries_organisation_id_reminder_id_idx" ON "alert_deliveries"("organisation_id", "reminder_id");

-- CreateIndex
CREATE UNIQUE INDEX "alert_deliveries_organisation_id_id_key" ON "alert_deliveries"("organisation_id", "id");

-- AddForeignKey
ALTER TABLE "deadline_policies" ADD CONSTRAINT "deadline_policies_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dsar_requests" ADD CONSTRAINT "dsar_requests_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dsar_requests" ADD CONSTRAINT "dsar_requests_business_unit_id_fkey" FOREIGN KEY ("organisation_id", "business_unit_id") REFERENCES "business_units"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dsar_requests" ADD CONSTRAINT "dsar_requests_owner_membership_id_fkey" FOREIGN KEY ("organisation_id", "owner_membership_id") REFERENCES "memberships"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dsar_requests" ADD CONSTRAINT "dsar_requests_policy_id_fkey" FOREIGN KEY ("organisation_id", "policy_id") REFERENCES "deadline_policies"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dsar_requests" ADD CONSTRAINT "dsar_requests_identity_verified_by_fkey" FOREIGN KEY ("identity_verified_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dsar_requests" ADD CONSTRAINT "dsar_requests_completed_by_user_id_fkey" FOREIGN KEY ("completed_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dsar_requests" ADD CONSTRAINT "dsar_requests_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dsar_extensions" ADD CONSTRAINT "dsar_extensions_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dsar_extensions" ADD CONSTRAINT "dsar_extensions_dsar_request_id_fkey" FOREIGN KEY ("organisation_id", "dsar_request_id") REFERENCES "dsar_requests"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dsar_extensions" ADD CONSTRAINT "dsar_extensions_decided_by_user_id_fkey" FOREIGN KEY ("decided_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dsar_communications" ADD CONSTRAINT "dsar_communications_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dsar_communications" ADD CONSTRAINT "dsar_communications_dsar_request_id_fkey" FOREIGN KEY ("organisation_id", "dsar_request_id") REFERENCES "dsar_requests"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dsar_communications" ADD CONSTRAINT "dsar_communications_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dsar_request_evidence" ADD CONSTRAINT "dsar_request_evidence_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dsar_request_evidence" ADD CONSTRAINT "dsar_request_evidence_request_id_fkey" FOREIGN KEY ("organisation_id", "dsar_request_id") REFERENCES "dsar_requests"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dsar_request_evidence" ADD CONSTRAINT "dsar_request_evidence_evidence_id_fkey" FOREIGN KEY ("organisation_id", "evidence_id") REFERENCES "evidence"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dsar_request_evidence" ADD CONSTRAINT "dsar_request_evidence_linked_by_user_id_fkey" FOREIGN KEY ("linked_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "breaches" ADD CONSTRAINT "breaches_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "breaches" ADD CONSTRAINT "breaches_business_unit_id_fkey" FOREIGN KEY ("organisation_id", "business_unit_id") REFERENCES "business_units"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "breaches" ADD CONSTRAINT "breaches_owner_membership_id_fkey" FOREIGN KEY ("organisation_id", "owner_membership_id") REFERENCES "memberships"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "breaches" ADD CONSTRAINT "breaches_policy_id_fkey" FOREIGN KEY ("organisation_id", "policy_id") REFERENCES "deadline_policies"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "breaches" ADD CONSTRAINT "breaches_closed_by_user_id_fkey" FOREIGN KEY ("closed_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "breaches" ADD CONSTRAINT "breaches_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "breach_chronology_entries" ADD CONSTRAINT "breach_chronology_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "breach_chronology_entries" ADD CONSTRAINT "breach_chronology_breach_id_fkey" FOREIGN KEY ("organisation_id", "breach_id") REFERENCES "breaches"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "breach_chronology_entries" ADD CONSTRAINT "breach_chronology_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "breach_notification_decisions" ADD CONSTRAINT "breach_decisions_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "breach_notification_decisions" ADD CONSTRAINT "breach_decisions_breach_id_fkey" FOREIGN KEY ("organisation_id", "breach_id") REFERENCES "breaches"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "breach_notification_decisions" ADD CONSTRAINT "breach_decisions_regulator_contact_id_fkey" FOREIGN KEY ("organisation_id", "regulator_contact_id") REFERENCES "regulator_contacts"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "breach_notification_decisions" ADD CONSTRAINT "breach_decisions_decided_by_user_id_fkey" FOREIGN KEY ("decided_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "breach_evidence" ADD CONSTRAINT "breach_evidence_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "breach_evidence" ADD CONSTRAINT "breach_evidence_breach_id_fkey" FOREIGN KEY ("organisation_id", "breach_id") REFERENCES "breaches"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "breach_evidence" ADD CONSTRAINT "breach_evidence_evidence_id_fkey" FOREIGN KEY ("organisation_id", "evidence_id") REFERENCES "evidence"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "breach_evidence" ADD CONSTRAINT "breach_evidence_linked_by_user_id_fkey" FOREIGN KEY ("linked_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence_versions" ADD CONSTRAINT "evidence_versions_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence_versions" ADD CONSTRAINT "evidence_versions_evidence_id_fkey" FOREIGN KEY ("organisation_id", "evidence_id") REFERENCES "evidence"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence_versions" ADD CONSTRAINT "evidence_versions_uploaded_by_user_id_fkey" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_owner_membership_id_fkey" FOREIGN KEY ("organisation_id", "owner_membership_id") REFERENCES "memberships"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_reviewed_by_user_id_fkey" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_attested_by_user_id_fkey" FOREIGN KEY ("attested_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_assignee_membership_id_fkey" FOREIGN KEY ("organisation_id", "assignee_membership_id") REFERENCES "memberships"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_completed_by_user_id_fkey" FOREIGN KEY ("completed_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_cancelled_by_user_id_fkey" FOREIGN KEY ("cancelled_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reminder_preferences" ADD CONSTRAINT "reminder_preferences_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reminder_preferences" ADD CONSTRAINT "reminder_preferences_membership_id_fkey" FOREIGN KEY ("organisation_id", "membership_id") REFERENCES "memberships"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_deliveries" ADD CONSTRAINT "alert_deliveries_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_deliveries" ADD CONSTRAINT "alert_deliveries_dsar_request_id_fkey" FOREIGN KEY ("organisation_id", "dsar_request_id") REFERENCES "dsar_requests"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_deliveries" ADD CONSTRAINT "alert_deliveries_breach_id_fkey" FOREIGN KEY ("organisation_id", "breach_id") REFERENCES "breaches"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_deliveries" ADD CONSTRAINT "alert_deliveries_reminder_id_fkey" FOREIGN KEY ("organisation_id", "reminder_id") REFERENCES "reminders"("organisation_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The file the Phase 5 rows described is copied into the version ledger before those columns go away, so
-- an uploaded evidence item survives its own upgrade with its checksum and storage key intact.
--
-- It has to run BEFORE `fca_enable_tenant_rls('evidence_versions')` and outside the tenant policies of
-- `evidence`: those tables are FORCE RLS (ADR-0004), so a cross-tenant read of the owner's own migration
-- would otherwise see zero rows and silently copy nothing. The owner bypass is taken for these two
-- statements only and put back immediately after them.
ALTER TABLE "evidence" NO FORCE ROW LEVEL SECURITY;

INSERT INTO "evidence_versions" (
    "id", "organisation_id", "evidence_id", "number", "original_filename", "content_type",
    "size", "sha256", "storage_key", "uploaded_by_user_id", "created_at"
)
SELECT
    -- A random uuid, not a uuidv7: the version rows of one item are ordered by `number`, never by id,
    -- and nothing pages through them by clock order.
    gen_random_uuid(), "organisation_id", "id", 1, "original_filename", "content_type",
    "size", "sha256", "storage_key", "uploaded_by_user_id", "created_at"
FROM "evidence";

ALTER TABLE "evidence" FORCE ROW LEVEL SECURITY;

-- The old CHECK guards the columns that are about to leave.
ALTER TABLE "evidence" DROP CONSTRAINT "evidence_check";

ALTER TABLE "evidence"
    DROP COLUMN "original_filename",
    DROP COLUMN "content_type",
    DROP COLUMN "size",
    DROP COLUMN "sha256",
    DROP COLUMN "storage_key";

-- ---------------------------------------------------------------------------------------------
-- Constraints. The rules the endpoints enforce are written a second time here, because a deadline that
-- does not follow from the numbers frozen on its own row is not a deadline anybody can stand behind.
--
-- "This text must be present and long enough" is written out in full (`x IS NOT NULL AND length(...) >= n`)
-- rather than leaning on `OR`: a CHECK that evaluates to NULL is satisfied, so `("a" <> 'X' OR length(b) >= 3)`
-- with a NULL b lets exactly the row it means to stop through. Verified by the probe script in this phase.
-- ---------------------------------------------------------------------------------------------

ALTER TABLE "deadline_policies" ADD CONSTRAINT "deadline_policies_check" CHECK (
  -- every window is either unset (the organisation has not chosen one) or a plausible number of days;
  -- 3660 is ten years, which is beyond any window this phase schedules
  ("dsar_response_days" IS NULL OR "dsar_response_days" BETWEEN 1 AND 3660)
  AND ("dsar_extension_days" IS NULL OR "dsar_extension_days" BETWEEN 1 AND 3660)
  AND ("dsar_extension_limit" IS NULL OR "dsar_extension_limit" BETWEEN 1 AND 12)
  AND ("breach_assessment_days" IS NULL OR "breach_assessment_days" BETWEEN 1 AND 3660)
  AND ("breach_notification_days" IS NULL OR "breach_notification_days" BETWEEN 1 AND 3660)
  AND ("alert_lead_days" IS NULL OR "alert_lead_days" BETWEEN 0 AND 366)
);

ALTER TABLE "dsar_requests" ADD CONSTRAINT "dsar_requests_check" CHECK (
  ("summary" IS NULL OR length("summary") <= 2000)
  AND ("subject_name" IS NULL OR length(btrim("subject_name")) <= 120)
  -- stored lower-case, like every other address in this schema
  AND ("subject_email" IS NULL OR ("subject_email" = lower("subject_email") AND length("subject_email") <= 320))
  AND ("identity_note" IS NULL OR length("identity_note") <= 2000)
  AND ("closure_note" IS NULL OR length("closure_note") <= 4000)
  -- the frozen policy numbers: a window, or nothing at all
  AND ("response_days" IS NULL OR "response_days" BETWEEN 1 AND 3660)
  AND ("response_days" IS NOT NULL) = ("base_due_on" IS NOT NULL)
  AND ("base_due_on" IS NULL OR "base_due_on" = "received_on" + "response_days")
  AND "extension_days" BETWEEN 0 AND 7320
  AND "extension_count" BETWEEN 0 AND 12
  AND ("extension_days" = 0 OR "base_due_on" IS NOT NULL)
  AND ("base_due_on" IS NOT NULL) = ("due_on" IS NOT NULL)
  AND ("due_on" IS NULL OR "due_on" = "base_due_on" + "extension_days")
  -- an identity is VERIFIED only when a named person checked it on a stated date
  AND ("identity_state" = 'VERIFIED') = ("identity_verified_on" IS NOT NULL)
  AND ("identity_state" = 'VERIFIED') = ("identity_verified_by_user_id" IS NOT NULL)
  AND ("identity_state" <> 'VERIFIED' OR "identity_verified_on" >= "received_on")
  -- a terminal status is a dated, attributed decision with a note, not an absence of work
  AND ("status" IN ('COMPLETED', 'REFUSED', 'WITHDRAWN')) = ("completed_on" IS NOT NULL)
  AND ("status" IN ('COMPLETED', 'REFUSED', 'WITHDRAWN')) = ("completed_by_user_id" IS NOT NULL)
  AND ("status" NOT IN ('COMPLETED', 'REFUSED', 'WITHDRAWN')
       OR ("closure_note" IS NOT NULL AND length(btrim("closure_note")) >= 3))
  AND ("completed_on" IS NULL OR "completed_on" >= "received_on")
);

ALTER TABLE "dsar_extensions" ADD CONSTRAINT "dsar_extensions_check" CHECK (
  "days" BETWEEN 1 AND 3660
  AND length(btrim("reason")) BETWEEN 3 AND 1000
  -- the arithmetic is part of the ledger: an extension moves the deadline by exactly the days it claims
  AND "new_due_on" = "previous_due_on" + "days"
);

ALTER TABLE "dsar_communications" ADD CONSTRAINT "dsar_communications_check" CHECK (
  length(btrim("note")) BETWEEN 1 AND 4000
);

ALTER TABLE "breaches" ADD CONSTRAINT "breaches_check" CHECK (
  length(btrim("title")) BETWEEN 1 AND 200
  AND ("description" IS NULL OR length("description") <= 4000)
  AND ("affected_data" IS NULL OR length("affected_data") <= 4000)
  AND ("impact" IS NULL OR length("impact") <= 4000)
  AND ("affected_subject_count" IS NULL OR "affected_subject_count" >= 0)
  AND ("closure_note" IS NULL OR length("closure_note") <= 4000)
  AND ("assessment_days" IS NULL OR "assessment_days" BETWEEN 1 AND 3660)
  AND ("assessment_days" IS NOT NULL) = ("assessment_due_on" IS NOT NULL)
  AND ("assessment_due_on" IS NULL OR "assessment_due_on" = "detected_on" + "assessment_days")
  AND ("notification_days" IS NULL OR "notification_days" BETWEEN 1 AND 3660)
  AND ("notification_days" IS NOT NULL) = ("notification_due_on" IS NOT NULL)
  AND ("notification_due_on" IS NULL OR "notification_due_on" = "detected_on" + "notification_days")
  AND ("status" = 'CLOSED') = ("closed_on" IS NOT NULL)
  AND ("status" = 'CLOSED') = ("closed_by_user_id" IS NOT NULL)
  AND ("status" <> 'CLOSED' OR ("closure_note" IS NOT NULL AND length(btrim("closure_note")) >= 3))
  AND ("closed_on" IS NULL OR "closed_on" >= "detected_on")
);

ALTER TABLE "breach_chronology_entries" ADD CONSTRAINT "breach_chronology_entries_check" CHECK (
  length(btrim("note")) BETWEEN 3 AND 4000
);

ALTER TABLE "breach_notification_decisions" ADD CONSTRAINT "breach_decisions_check" CHECK (
  length(btrim("reason")) BETWEEN 3 AND 1000
  AND ("authority_name" IS NULL OR length(btrim("authority_name")) BETWEEN 2 AND 200)
  -- a decision to notify names an authority and a date to meet
  AND ("decision" = 'REQUIRED') = ("target_date" IS NOT NULL)
  AND (
    CASE WHEN "decision" = 'REQUIRED' THEN
      ("regulator_contact_id" IS NOT NULL)::int + ("authority_name" IS NOT NULL)::int = 1
    ELSE
      "regulator_contact_id" IS NULL AND "authority_name" IS NULL
    END
  )
);

ALTER TABLE "evidence_versions" ADD CONSTRAINT "evidence_versions_check" CHECK (
  "number" >= 1
  AND length(btrim("original_filename")) BETWEEN 1 AND 255
  AND length(btrim("content_type")) BETWEEN 1 AND 200
  -- the same ceiling the upload route applies (MAX_EVIDENCE_BYTES)
  AND "size" BETWEEN 1 AND 10485760
  AND "sha256" ~ '^[0-9a-f]{64}$'
  AND length("storage_key") BETWEEN 1 AND 512
  AND ("note" IS NULL OR length("note") <= 1000)
);

ALTER TABLE "evidence" ADD CONSTRAINT "evidence_check" CHECK (
  length(btrim("title")) BETWEEN 1 AND 200
  AND ("description" IS NULL OR length("description") <= 2000)
  AND "current_version" >= 1
  -- a review outcome is a named person's decision; UNREVIEWED and UNDER_REVIEW are not
  AND ("review_status" IN ('ACCEPTED', 'REJECTED')) = ("reviewed_by_user_id" IS NOT NULL)
  AND ("review_status" <> 'REJECTED' OR ("review_note" IS NOT NULL AND length(btrim("review_note")) >= 3))
  AND ("review_note" IS NULL OR length("review_note") <= 4000)
  AND ("last_review_date" IS NULL OR "next_review_date" IS NULL OR "next_review_date" > "last_review_date")
  -- a scan result is a dated attestation about the CURRENT version, and only that version
  AND ("scan_state" = 'NOT_SCANNED') <> ("scanned_on" IS NOT NULL)
  AND ("scan_state" = 'NOT_SCANNED') = ("attested_by_user_id" IS NULL)
  AND ("scan_note" IS NULL OR length("scan_note") <= 1000)
  AND ("scan_state" NOT IN ('INFECTED', 'UNABLE_TO_SCAN')
       OR ("scan_note" IS NOT NULL AND length(btrim("scan_note")) >= 3))
);

ALTER TABLE "reminders" ADD CONSTRAINT "reminders_check" CHECK (
  length(btrim("title")) BETWEEN 1 AND 200
  AND ("note" IS NULL OR length("note") <= 2000)
  AND ("lead_days" IS NULL OR "lead_days" BETWEEN 0 AND 366)
  -- a source is a kind and an id together, never one without the other
  AND ("source_kind" IS NULL) = ("source_id" IS NULL)
  AND ("source_label" IS NULL OR "source_kind" IS NOT NULL)
  AND ("source_label" IS NULL OR length(btrim("source_label")) <= 120)
  AND ("status" = 'DONE') = ("completed_on" IS NOT NULL)
  AND ("status" = 'DONE') = ("completed_by_user_id" IS NOT NULL)
  AND ("status" = 'CANCELLED') = ("cancelled_on" IS NOT NULL)
  AND ("status" = 'CANCELLED') = ("cancelled_by_user_id" IS NOT NULL)
  AND ("status" <> 'CANCELLED' OR ("cancel_reason" IS NOT NULL AND length(btrim("cancel_reason")) >= 3))
  AND ("completed_on" IS NULL OR "cancelled_on" IS NULL)
);

ALTER TABLE "alert_deliveries" ADD CONSTRAINT "alert_deliveries_check" CHECK (
  length(btrim("dedupe_key")) BETWEEN 1 AND 200
  -- exactly one source, of the kind the alert names
  AND ("dsar_request_id" IS NOT NULL)::int + ("breach_id" IS NOT NULL)::int + ("reminder_id" IS NOT NULL)::int = 1
  AND ("kind" IN ('DSAR_DUE_SOON', 'DSAR_OVERDUE')) = ("dsar_request_id" IS NOT NULL)
  AND ("kind" IN ('BREACH_RECORDED', 'BREACH_ASSESSMENT_DUE', 'BREACH_NOTIFICATION_DUE')) = ("breach_id" IS NOT NULL)
  AND ("kind" IN ('REMINDER_DUE_SOON', 'REMINDER_OVERDUE')) = ("reminder_id" IS NOT NULL)
  AND ("recipient_address" IS NULL OR ("recipient_address" = lower("recipient_address") AND length("recipient_address") <= 320))
  AND ("recipient_label" IS NULL OR length("recipient_label") <= 200)
  AND "attempts" >= 0
  AND ("status" = 'SENT') = ("sent_at" IS NOT NULL)
  AND ("status" = 'SENT' OR "sent_at" IS NULL)
  AND ("status" = 'SKIPPED') = ("skip_reason" IS NOT NULL)
  AND ("status" = 'FAILED') = ("last_error" IS NOT NULL)
  AND ("last_error" IS NULL OR length("last_error") <= 500)
  -- nothing leaves without an address to go to
  AND ("status" <> 'SENT' OR "recipient_address" IS NOT NULL)
);

-- Row-level security for every new tenant table (ADR-0004; the helper comes from the 2c migration).
SELECT "fca_enable_tenant_rls"('deadline_policies');
SELECT "fca_enable_tenant_rls"('dsar_requests');
SELECT "fca_enable_tenant_rls"('dsar_extensions');
SELECT "fca_enable_tenant_rls"('dsar_communications');
SELECT "fca_enable_tenant_rls"('dsar_request_evidence');
SELECT "fca_enable_tenant_rls"('breaches');
SELECT "fca_enable_tenant_rls"('breach_chronology_entries');
SELECT "fca_enable_tenant_rls"('breach_notification_decisions');
SELECT "fca_enable_tenant_rls"('breach_evidence');
SELECT "fca_enable_tenant_rls"('evidence_versions');
SELECT "fca_enable_tenant_rls"('reminders');
SELECT "fca_enable_tenant_rls"('reminder_preferences');
SELECT "fca_enable_tenant_rls"('alert_deliveries');

-- ---------------------------------------------------------------------------------------------
-- Append-only ledgers. What was asked, what was decided, when it was told and which file was filed is
-- the evidence a later review reads; the runtime role is additionally refused the privilege
-- (prisma/sql/runtime-role.sql).
-- ---------------------------------------------------------------------------------------------

CREATE FUNCTION "fca_reject_mutation"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (% is not allowed)', TG_TABLE_NAME, TG_OP;
END
$$;

CREATE TRIGGER "dsar_extensions_no_update_delete"
  BEFORE UPDATE OR DELETE ON "dsar_extensions"
  FOR EACH ROW EXECUTE FUNCTION "fca_reject_mutation"();

CREATE TRIGGER "dsar_communications_no_update_delete"
  BEFORE UPDATE OR DELETE ON "dsar_communications"
  FOR EACH ROW EXECUTE FUNCTION "fca_reject_mutation"();

CREATE TRIGGER "breach_chronology_no_update_delete"
  BEFORE UPDATE OR DELETE ON "breach_chronology_entries"
  FOR EACH ROW EXECUTE FUNCTION "fca_reject_mutation"();

CREATE TRIGGER "breach_decisions_no_update_delete"
  BEFORE UPDATE OR DELETE ON "breach_notification_decisions"
  FOR EACH ROW EXECUTE FUNCTION "fca_reject_mutation"();

CREATE TRIGGER "evidence_versions_no_update_delete"
  BEFORE UPDATE OR DELETE ON "evidence_versions"
  FOR EACH ROW EXECUTE FUNCTION "fca_reject_mutation"();

-- An alert row is written when the work is queued and only its outcome may change afterwards: who it went
-- to, whether it went, and why not. Rewriting the key, the kind or the deadline would rewrite history.
CREATE FUNCTION "fca_guard_alert_delivery"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'alert delivery % cannot be deleted', OLD."id";
  END IF;
  IF (to_jsonb(NEW) - 'status' - 'recipient_address' - 'recipient_label' - 'skip_reason'
        - 'last_error' - 'attempts' - 'sent_at' - 'updated_at')
     <> (to_jsonb(OLD) - 'status' - 'recipient_address' - 'recipient_label' - 'skip_reason'
        - 'last_error' - 'attempts' - 'sent_at' - 'updated_at') THEN
    RAISE EXCEPTION 'alert delivery % was written once; only its outcome may change', OLD."id";
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "alert_deliveries_guard" BEFORE UPDATE OR DELETE ON "alert_deliveries"
  FOR EACH ROW EXECUTE FUNCTION "fca_guard_alert_delivery"();

-- Extensions chain: each one starts from the due date the request actually has, and a request that is
-- finished cannot be extended after the fact.
CREATE FUNCTION "fca_guard_dsar_extension"() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_due date;
  v_status "DsarStatus";
BEGIN
  SELECT r."due_on", r."status" INTO v_due, v_status
  FROM "dsar_requests" r WHERE r."id" = NEW."dsar_request_id";
  IF v_status IN ('COMPLETED', 'REFUSED', 'WITHDRAWN') THEN
    RAISE EXCEPTION 'dsar request % is % and cannot be extended', NEW."dsar_request_id", v_status;
  END IF;
  IF v_due IS DISTINCT FROM NEW."previous_due_on" THEN
    RAISE EXCEPTION 'extension of dsar request % must start from its due date in force (%)', NEW."dsar_request_id", v_due;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "dsar_extensions_chain_guard" BEFORE INSERT ON "dsar_extensions"
  FOR EACH ROW EXECUTE FUNCTION "fca_guard_dsar_extension"();

-- The two totals on a request are claims about its ledger, so the ledger is asked: the days and the count
-- must be what the extension rows actually add up to.
CREATE FUNCTION "fca_guard_dsar_request_ledger"() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_days integer;
  v_rows integer;
BEGIN
  SELECT COALESCE(sum(e."days"), 0)::int, count(*)::int INTO v_days, v_rows
  FROM "dsar_extensions" e WHERE e."dsar_request_id" = NEW."id";
  IF v_days <> NEW."extension_days" OR v_rows <> NEW."extension_count" THEN
    RAISE EXCEPTION 'dsar request % carries % days over % extensions, its ledger has % over %',
      NEW."id", NEW."extension_days", NEW."extension_count", v_days, v_rows;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "dsar_requests_ledger_guard" BEFORE UPDATE ON "dsar_requests"
  FOR EACH ROW EXECUTE FUNCTION "fca_guard_dsar_request_ledger"();

-- A decision belongs to a live investigation: once a breach is closed, what is known about it is fixed.
CREATE FUNCTION "fca_guard_breach_decision"() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_status "BreachStatus";
BEGIN
  SELECT b."status" INTO v_status FROM "breaches" b WHERE b."id" = NEW."breach_id";
  IF v_status = 'CLOSED' THEN
    RAISE EXCEPTION 'breach % is closed; a notification decision cannot be added to it', NEW."breach_id";
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "breach_decisions_open_guard" BEFORE INSERT ON "breach_notification_decisions"
  FOR EACH ROW EXECUTE FUNCTION "fca_guard_breach_decision"();

-- `notification_state` is a claim about the decision ledger, exactly as an ACCEPTED risk is: the newest row
-- has to agree with it. And nothing closes without one — the absence of a decision is not a decision.
CREATE FUNCTION "fca_guard_breach_notification"() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_decision "BreachNotificationDecisionKind";
  v_rows integer;
BEGIN
  SELECT count(*)::int INTO v_rows FROM "breach_notification_decisions" d WHERE d."breach_id" = NEW."id";
  IF NEW."status" = 'CLOSED' AND v_rows = 0 THEN
    RAISE EXCEPTION 'breach % cannot be closed before a notification decision is recorded', NEW."id";
  END IF;
  IF NEW."notification_state" = 'UNDECIDED' THEN
    RETURN NEW;
  END IF;
  SELECT d."decision" INTO v_decision
  FROM "breach_notification_decisions" d
  WHERE d."breach_id" = NEW."id"
  ORDER BY d."decided_at" DESC, d."id" DESC
  LIMIT 1;
  IF v_decision IS DISTINCT FROM (
    CASE WHEN NEW."notification_state" = 'NOTIFICATION_REQUIRED'
         THEN 'REQUIRED'::"BreachNotificationDecisionKind"
         ELSE 'NOT_REQUIRED'::"BreachNotificationDecisionKind"
    END
  ) THEN
    RAISE EXCEPTION 'breach % notification state does not match its newest decision', NEW."id";
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "breaches_notification_guard" BEFORE INSERT OR UPDATE ON "breaches"
  FOR EACH ROW EXECUTE FUNCTION "fca_guard_breach_notification"();

-- `current_version` is a pointer into the version ledger, and a new file is new bytes: the attestation
-- that covered the old one cannot be carried over to it.
CREATE FUNCTION "fca_guard_evidence_version"() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_top integer;
BEGIN
  IF NEW."current_version" = OLD."current_version" THEN
    RETURN NEW;
  END IF;
  SELECT COALESCE(max(v."number"), 0) INTO v_top
  FROM "evidence_versions" v WHERE v."evidence_id" = NEW."id";
  IF NEW."current_version" <> v_top THEN
    RAISE EXCEPTION 'evidence % points at version % but the newest stored version is %', NEW."id", NEW."current_version", v_top;
  END IF;
  IF NEW."scan_state" <> 'NOT_SCANNED' THEN
    RAISE EXCEPTION 'evidence % has a new file: its scan state must go back to NOT_SCANNED', NEW."id";
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "evidence_current_version_guard" BEFORE UPDATE ON "evidence"
  FOR EACH ROW EXECUTE FUNCTION "fca_guard_evidence_version"();
