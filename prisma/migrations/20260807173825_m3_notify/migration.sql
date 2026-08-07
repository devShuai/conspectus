-- CreateEnum
CREATE TYPE "NotificationRuleType" AS ENUM ('renewal_due', 'trial_ending', 'usage_threshold', 'balance_low', 'collector_stale', 'price_change', 'connection_failed');

-- CreateEnum
CREATE TYPE "NotificationChannelType" AS ENUM ('email', 'webhook');

-- CreateEnum
CREATE TYPE "NotificationChannelMode" AS ENUM ('individual', 'daily_digest');

-- CreateEnum
CREATE TYPE "NotificationEventStatus" AS ENUM ('pending');

-- CreateEnum
CREATE TYPE "NotificationDeliveryStatus" AS ENUM ('pending', 'sending', 'sent', 'failed', 'blocked', 'canceled');

-- CreateEnum
CREATE TYPE "NotificationDigestStatus" AS ENUM ('pending', 'sending', 'sent', 'failed', 'canceled');

-- CreateTable
CREATE TABLE "notification_rules" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "type" "NotificationRuleType" NOT NULL,
    "config" JSONB NOT NULL,
    "subscriptionId" UUID,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "notification_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_channels" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "type" "NotificationChannelType" NOT NULL,
    "mode" "NotificationChannelMode" NOT NULL DEFAULT 'individual',
    "destination" TEXT,
    "secretCipher" BYTEA,
    "verifiedAt" TIMESTAMPTZ,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "notification_channels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_events" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "ruleId" UUID NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" UUID NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "occurredAt" TIMESTAMPTZ NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_deliveries" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "channelId" UUID NOT NULL,
    "digestId" UUID,
    "scheduledAt" TIMESTAMPTZ NOT NULL,
    "status" "NotificationDeliveryStatus" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMPTZ,
    "leaseUntil" TIMESTAMPTZ,
    "leaseToken" UUID,
    "lastError" TEXT,
    "sentAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "notification_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_digests" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "channelId" UUID NOT NULL,
    "localDate" DATE NOT NULL,
    "scheduledAt" TIMESTAMPTZ NOT NULL,
    "status" "NotificationDigestStatus" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMPTZ,
    "leaseUntil" TIMESTAMPTZ,
    "leaseToken" UUID,
    "lastError" TEXT,
    "sentAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "notification_digests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_arm_states" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "ruleId" UUID NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" UUID NOT NULL,
    "armedAt" TIMESTAMPTZ NOT NULL,
    "armKey" TEXT NOT NULL,
    "clearedAt" TIMESTAMPTZ,
    "meta" JSONB,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "notification_arm_states_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_changes" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "subscriptionId" UUID NOT NULL,
    "oldPrice" DECIMAL(14,2) NOT NULL,
    "newPrice" DECIMAL(14,2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "effectiveAt" DATE NOT NULL,
    "detectedBy" TEXT NOT NULL DEFAULT 'user',
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "price_changes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notification_rules_userId_enabled_idx" ON "notification_rules"("userId", "enabled");

-- CreateIndex
CREATE INDEX "notification_channels_userId_enabled_idx" ON "notification_channels"("userId", "enabled");

-- CreateIndex
CREATE INDEX "notification_events_userId_occurredAt_idx" ON "notification_events"("userId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "notification_events_userId_ruleId_subjectType_subjectId_ded_key" ON "notification_events"("userId", "ruleId", "subjectType", "subjectId", "dedupeKey");

-- CreateIndex
CREATE INDEX "notification_deliveries_userId_status_nextAttemptAt_idx" ON "notification_deliveries"("userId", "status", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "notification_deliveries_eventId_channelId_key" ON "notification_deliveries"("eventId", "channelId");

-- CreateIndex
CREATE INDEX "notification_digests_userId_status_scheduledAt_idx" ON "notification_digests"("userId", "status", "scheduledAt");

-- CreateIndex
CREATE UNIQUE INDEX "notification_digests_channelId_localDate_key" ON "notification_digests"("channelId", "localDate");

-- CreateIndex
CREATE INDEX "notification_arm_states_userId_idx" ON "notification_arm_states"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "notification_arm_states_ruleId_subjectType_subjectId_key" ON "notification_arm_states"("ruleId", "subjectType", "subjectId");

-- CreateIndex
CREATE INDEX "price_changes_userId_subscriptionId_idx" ON "price_changes"("userId", "subscriptionId");

-- AddForeignKey
ALTER TABLE "notification_rules" ADD CONSTRAINT "notification_rules_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_channels" ADD CONSTRAINT "notification_channels_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_events" ADD CONSTRAINT "notification_events_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_events" ADD CONSTRAINT "notification_events_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "notification_rules"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "notification_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "notification_channels"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_digestId_fkey" FOREIGN KEY ("digestId") REFERENCES "notification_digests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_digests" ADD CONSTRAINT "notification_digests_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_digests" ADD CONSTRAINT "notification_digests_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "notification_channels"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_arm_states" ADD CONSTRAINT "notification_arm_states_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_arm_states" ADD CONSTRAINT "notification_arm_states_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "notification_rules"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_changes" ADD CONSTRAINT "price_changes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_changes" ADD CONSTRAINT "price_changes_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "subscriptions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- M3 notify: channel secret must exist for webhook only; rule events require rule linkage
ALTER TABLE "notification_channels"
  ADD CONSTRAINT notify_channel_secret CHECK (
    ("type" = 'webhook' AND "secretCipher" IS NOT NULL AND "destination" IS NOT NULL)
    OR ("type" = 'email' AND "secretCipher" IS NULL)
  );
