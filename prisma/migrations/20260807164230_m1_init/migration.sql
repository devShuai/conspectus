-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('active', 'suspended');

-- CreateEnum
CREATE TYPE "UserStatusReason" AS ENUM ('admin', 'certus_locked', 'certus_disabled');

-- CreateEnum
CREATE TYPE "CertusLinkStatus" AS ENUM ('active', 'reauth_required');

-- CreateEnum
CREATE TYPE "EmailVerificationSource" AS ENUM ('local', 'certus');

-- CreateEnum
CREATE TYPE "SessionAuthMethod" AS ENUM ('certus', 'local');

-- CreateEnum
CREATE TYPE "VendorCategory" AS ENUM ('streaming', 'ai', 'cloud', 'dev_tool', 'storage', 'domain', 'music', 'news', 'game', 'other');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('trial', 'active', 'paused', 'canceled', 'expired');

-- CreateEnum
CREATE TYPE "BillingCycle" AS ENUM ('weekly', 'monthly', 'quarterly', 'yearly', 'custom', 'lifetime', 'one_time');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "certusSub" TEXT,
    "email" TEXT,
    "emailVerifiedAt" TIMESTAMP(3),
    "emailVerificationSource" "EmailVerificationSource",
    "emailSnapshotIssuedAt" TIMESTAMP(3),
    "emailSyncRequiredAt" TIMESTAMP(3),
    "lastStatusSyncedAt" TIMESTAMP(3),
    "certusLinkStatus" "CertusLinkStatus",
    "statusCheckFailureCount" INTEGER NOT NULL DEFAULT 0,
    "nextStatusCheckAt" TIMESTAMP(3),
    "statusSyncLeaseUntil" TIMESTAMP(3),
    "statusSyncLeaseToken" UUID,
    "lastStatusSyncError" TEXT,
    "passwordHash" TEXT,
    "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "name" TEXT,
    "baseCurrency" CHAR(3) NOT NULL DEFAULT 'CNY',
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Shanghai',
    "inboundAddress" TEXT,
    "status" "UserStatus" NOT NULL DEFAULT 'active',
    "statusReason" "UserStatusReason",
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenHash" BYTEA NOT NULL,
    "authMethod" "SessionAuthMethod" NOT NULL,
    "idleExpiresAt" TIMESTAMPTZ NOT NULL,
    "absoluteExpiresAt" TIMESTAMPTZ NOT NULL,
    "lastSeenAt" TIMESTAMPTZ NOT NULL,
    "certusSid" TEXT,
    "certusRefreshTokenCipher" BYTEA,
    "certusIdTokenCipher" BYTEA,
    "lastIdentityCheckedAt" TIMESTAMPTZ,
    "authTime" TIMESTAMPTZ NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "backchannel_logout_replays" (
    "issuer" TEXT NOT NULL,
    "jti" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "backchannel_logout_replays_pkey" PRIMARY KEY ("issuer","jti")
);

-- CreateTable
CREATE TABLE "reauth_transactions" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "tokenHash" BYTEA NOT NULL,
    "expiresAt" TIMESTAMPTZ NOT NULL,
    "verifiedAt" TIMESTAMPTZ,
    "consumedAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reauth_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendors" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" "VendorCategory" NOT NULL,
    "homepage" TEXT,
    "cancelUrl" TEXT,
    "logoUrl" TEXT,
    "userId" UUID,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "vendors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "vendorId" UUID,
    "name" TEXT NOT NULL,
    "planName" TEXT,
    "status" "SubscriptionStatus" NOT NULL,
    "price" DECIMAL(14,2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "billingCycle" "BillingCycle" NOT NULL,
    "cycleDays" INTEGER,
    "anchorDay" INTEGER,
    "startedAt" DATE NOT NULL,
    "nextBillingAt" DATE,
    "endedAt" DATE,
    "trialEndsAt" DATE,
    "autoRenew" BOOLEAN NOT NULL DEFAULT true,
    "paymentMethodId" UUID,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "notes" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_certusSub_key" ON "users"("certusSub");

-- CreateIndex
CREATE UNIQUE INDEX "users_inboundAddress_key" ON "users"("inboundAddress");

-- CreateIndex
CREATE INDEX "users_status_idx" ON "users"("status");

-- CreateIndex
CREATE INDEX "users_certusLinkStatus_idx" ON "users"("certusLinkStatus");

-- CreateIndex
CREATE INDEX "users_nextStatusCheckAt_idx" ON "users"("nextStatusCheckAt");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_tokenHash_key" ON "sessions"("tokenHash");

-- CreateIndex
CREATE INDEX "sessions_userId_idx" ON "sessions"("userId");

-- CreateIndex
CREATE INDEX "sessions_certusSid_idx" ON "sessions"("certusSid");

-- CreateIndex
CREATE INDEX "sessions_idleExpiresAt_idx" ON "sessions"("idleExpiresAt");

-- CreateIndex
CREATE INDEX "sessions_absoluteExpiresAt_idx" ON "sessions"("absoluteExpiresAt");

-- CreateIndex
CREATE INDEX "backchannel_logout_replays_expiresAt_idx" ON "backchannel_logout_replays"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "reauth_transactions_tokenHash_key" ON "reauth_transactions"("tokenHash");

-- CreateIndex
CREATE INDEX "reauth_transactions_userId_idx" ON "reauth_transactions"("userId");

-- CreateIndex
CREATE INDEX "reauth_transactions_sessionId_idx" ON "reauth_transactions"("sessionId");

-- CreateIndex
CREATE INDEX "reauth_transactions_expiresAt_idx" ON "reauth_transactions"("expiresAt");

-- CreateIndex
CREATE INDEX "subscriptions_userId_status_idx" ON "subscriptions"("userId", "status");

-- CreateIndex
CREATE INDEX "subscriptions_userId_nextBillingAt_idx" ON "subscriptions"("userId", "nextBillingAt");

-- CreateIndex
CREATE INDEX "subscriptions_userId_vendorId_idx" ON "subscriptions"("userId", "vendorId");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reauth_transactions" ADD CONSTRAINT "reauth_transactions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "vendors"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ============================================================
-- Hand-written constraints (beyond Prisma expressiveness)
-- design.md §6.2; verified by prisma/migrations/constraints.sql tests
-- ============================================================

-- User: at least one login method; certus fields consistency
ALTER TABLE "users"
  ADD CONSTRAINT users_login_method CHECK (("certusSub" IS NOT NULL) OR ("passwordHash" IS NOT NULL));

ALTER TABLE "users"
  ADD CONSTRAINT users_certus_link_pairing CHECK (("certusSub" IS NULL) = ("certusLinkStatus" IS NULL));

ALTER TABLE "users"
  ADD CONSTRAINT users_certus_sync_required CHECK (("certusSub" IS NULL) OR ("lastStatusSyncedAt" IS NOT NULL));

ALTER TABLE "users"
  ADD CONSTRAINT users_email_verification_pairing CHECK (("emailVerifiedAt" IS NULL) = ("emailVerificationSource" IS NULL));

ALTER TABLE "users"
  ADD CONSTRAINT users_email_sync_requires_certus CHECK (("emailSyncRequiredAt" IS NULL) OR ("certusSub" IS NOT NULL));

-- User: suspended requires a reason
ALTER TABLE "users"
  ADD CONSTRAINT users_suspended_reason CHECK (
    ("status" = 'suspended' AND "statusReason" IS NOT NULL)
    OR ("status" = 'active' AND "statusReason" IS NULL)
  );

-- User: local email uniqueness (only for local-password accounts)
CREATE UNIQUE INDEX users_local_email_unique
  ON "users" (lower("email"))
  WHERE "passwordHash" IS NOT NULL AND "email" IS NOT NULL;

-- Session: certus-only cipher fields must belong to certus sessions
ALTER TABLE "sessions"
  ADD CONSTRAINT sessions_certus_fields CHECK (
    ("authMethod" = 'certus') OR ("certusSid" IS NULL AND "certusRefreshTokenCipher" IS NULL AND "certusIdTokenCipher" IS NULL)
  );

-- Vendor: partial unique slug for system catalog vs per-user private
CREATE UNIQUE INDEX vendors_system_slug_unique ON "vendors" ("slug") WHERE "userId" IS NULL;
CREATE UNIQUE INDEX vendors_private_slug_unique ON "vendors" ("userId", "slug") WHERE "userId" IS NOT NULL;

-- Subscription: only system or own private vendor (composite FK alternative via trigger)
CREATE OR REPLACE FUNCTION subscriptions_vendor_owner_check() RETURNS trigger AS $$
BEGIN
  IF NEW."vendorId" IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM "vendors" v
      WHERE v."id" = NEW."vendorId"
        AND (v."userId" IS NULL OR v."userId" = NEW."userId")
    ) THEN
      RAISE EXCEPTION 'subscription vendor must be a system vendor or owned by the same user';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS subscriptions_vendor_owner_check_trigger ON "subscriptions";
CREATE TRIGGER subscriptions_vendor_owner_check_trigger
  BEFORE INSERT OR UPDATE OF "vendorId", "userId" ON "subscriptions"
  FOR EACH ROW EXECUTE FUNCTION subscriptions_vendor_owner_check();

-- Subscription: trial requires trialEndsAt; custom requires cycleDays; anchor bounds
ALTER TABLE "subscriptions"
  ADD CONSTRAINT subscriptions_trial_requires_ends CHECK (
    ("status" = 'trial') = ("trialEndsAt" IS NOT NULL)
  );

ALTER TABLE "subscriptions"
  ADD CONSTRAINT subscriptions_custom_cycle_days CHECK (
    ("billingCycle" = 'custom') = ("cycleDays" IS NOT NULL)
  );

ALTER TABLE "subscriptions"
  ADD CONSTRAINT subscriptions_anchor_day_bounds CHECK (
    "anchorDay" IS NULL OR ("anchorDay" BETWEEN 1 AND 31)
  );

ALTER TABLE "subscriptions"
  ADD CONSTRAINT subscriptions_lifetime_one_time_no_next CHECK (
    NOT ("billingCycle" IN ('lifetime', 'one_time')) OR ("nextBillingAt" IS NULL)
  );

-- Session: tokenHash bytes length (SHA-256 = 32)
ALTER TABLE "sessions"
  ADD CONSTRAINT sessions_token_hash_len CHECK (octet_length("tokenHash") = 32);

ALTER TABLE "reauth_transactions"
  ADD CONSTRAINT reauth_token_hash_len CHECK (octet_length("tokenHash") = 32);
