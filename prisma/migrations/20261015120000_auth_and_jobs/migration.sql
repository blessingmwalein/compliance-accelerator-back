-- CreateEnum
CREATE TYPE "auth_token_purpose" AS ENUM ('EMAIL_VERIFICATION', 'PASSWORD_RESET');

-- CreateEnum
CREATE TYPE "session_revoked_reason" AS ENUM ('LOGOUT', 'REFRESH_REUSE', 'PASSWORD_RESET', 'EXPIRED');

-- CreateEnum
CREATE TYPE "job_status" AS ENUM ('QUEUED', 'LEASED', 'SUCCEEDED', 'DEAD');

-- CreateEnum
CREATE TYPE "email_status" AS ENUM ('QUEUED', 'SENT', 'DELIVERED', 'BOUNCED', 'COMPLAINED', 'FAILED', 'SUPPRESSED');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "email_verified_at" TIMESTAMPTZ,
ADD COLUMN     "last_login_at" TIMESTAMPTZ,
ADD COLUMN     "password_hash" TEXT;

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "revoked_at" TIMESTAMPTZ,
    "revoked_reason" "session_revoked_reason",
    "user_agent" TEXT,
    "ip_hash" TEXT,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "used_at" TIMESTAMPTZ,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "purpose" "auth_token_purpose" NOT NULL,
    "token_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "consumed_at" TIMESTAMPTZ,

    CONSTRAINT "auth_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "login_attempts" (
    "id" UUID NOT NULL,
    "account_hash" TEXT NOT NULL,
    "ip_hash" TEXT,
    "succeeded" BOOLEAN NOT NULL,
    "attempted_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "login_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "security_events" (
    "id" UUID NOT NULL,
    "occurred_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "event_type" TEXT NOT NULL,
    "outcome" "audit_outcome" NOT NULL DEFAULT 'SUCCESS',
    "user_id" UUID,
    "subject_hash" TEXT,
    "ip_hash" TEXT,
    "request_id" TEXT,
    "metadata" JSONB,

    CONSTRAINT "security_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jobs" (
    "id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "run_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "job_status" NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 5,
    "lease_until" TIMESTAMPTZ,
    "leased_by" TEXT,
    "dedupe_key" TEXT NOT NULL,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "finished_at" TIMESTAMPTZ,

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_deliveries" (
    "id" UUID NOT NULL,
    "to_address" TEXT NOT NULL,
    "template" TEXT NOT NULL,
    "status" "email_status" NOT NULL DEFAULT 'QUEUED',
    "provider_message_id" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "sent_at" TIMESTAMPTZ,

    CONSTRAINT "email_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sessions_user_id_revoked_at_idx" ON "sessions"("user_id", "revoked_at");

-- CreateIndex
CREATE INDEX "sessions_expires_at_idx" ON "sessions"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_tokens_session_id_idx" ON "refresh_tokens"("session_id");

-- CreateIndex
CREATE UNIQUE INDEX "auth_tokens_token_hash_key" ON "auth_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "auth_tokens_user_id_purpose_idx" ON "auth_tokens"("user_id", "purpose");

-- CreateIndex
CREATE INDEX "login_attempts_account_hash_attempted_at_idx" ON "login_attempts"("account_hash", "attempted_at" DESC);

-- CreateIndex
CREATE INDEX "login_attempts_ip_hash_attempted_at_idx" ON "login_attempts"("ip_hash", "attempted_at" DESC);

-- CreateIndex
CREATE INDEX "security_events_occurred_at_idx" ON "security_events"("occurred_at" DESC);

-- CreateIndex
CREATE INDEX "security_events_user_id_occurred_at_idx" ON "security_events"("user_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "security_events_event_type_occurred_at_idx" ON "security_events"("event_type", "occurred_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "jobs_dedupe_key_key" ON "jobs"("dedupe_key");

-- CreateIndex
CREATE INDEX "email_deliveries_to_address_created_at_idx" ON "email_deliveries"("to_address", "created_at" DESC);

-- CreateIndex
CREATE INDEX "email_deliveries_status_idx" ON "email_deliveries"("status");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_tokens" ADD CONSTRAINT "auth_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "security_events" ADD CONSTRAINT "security_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------------
-- Hand-written additions (not generated by Prisma; they are not part of schema.prisma).
-- ---------------------------------------------------------------------------------------------

-- Sanity checks that keep a bug from creating impossible rows.
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_attempts_check" CHECK ("attempts" >= 0 AND "max_attempts" >= 1);
ALTER TABLE "email_deliveries" ADD CONSTRAINT "email_deliveries_attempts_check" CHECK ("attempts" >= 0);
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_expiry_check" CHECK ("expires_at" > "created_at");
ALTER TABLE "auth_tokens" ADD CONSTRAINT "auth_tokens_expiry_check" CHECK ("expires_at" > "created_at");

-- Claim queries scan only the rows that can be claimed (Prisma cannot model partial indexes).
CREATE INDEX "jobs_queued_run_at_idx" ON "jobs" ("run_at") WHERE "status" = 'QUEUED';
CREATE INDEX "jobs_leased_lease_until_idx" ON "jobs" ("lease_until") WHERE "status" = 'LEASED';

-- Security events are append-only for every role, like audit_events (see the previous migration).
-- The default error code is used on purpose: Prisma hides the message of class 23 errors.
CREATE FUNCTION "security_events_reject_mutation"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'security_events is append-only (% is not allowed)', TG_OP;
END;
$$;

CREATE TRIGGER "security_events_no_update_delete"
BEFORE UPDATE OR DELETE ON "security_events"
FOR EACH ROW EXECUTE FUNCTION "security_events_reject_mutation"();
