-- CreateEnum
CREATE TYPE "UsageKind" AS ENUM ('quota', 'balance', 'counter');

-- CreateEnum
CREATE TYPE "UsageResetCycle" AS ENUM ('daily', 'weekly', 'monthly', 'billing_cycle', 'never');

-- CreateEnum
CREATE TYPE "UsageSource" AS ENUM ('manual', 'provider', 'local_agent');

-- CreateEnum
CREATE TYPE "UsageSyncStatus" AS ENUM ('ok', 'auth_failed', 'rate_limited', 'error');

-- CreateEnum
CREATE TYPE "BindingStatus" AS ENUM ('active', 'revoked');

-- CreateEnum
CREATE TYPE "ConnectionStatus" AS ENUM ('active', 'auth_failed', 'degraded', 'disabled');

-- CreateTable
CREATE TABLE "usage_quotas" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "subscriptionId" UUID NOT NULL,
    "kind" "UsageKind" NOT NULL,
    "metric" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "limitValue" DECIMAL(20,4),
    "usedValue" DECIMAL(20,4),
    "remainingValue" DECIMAL(20,4),
    "resetCycle" "UsageResetCycle" NOT NULL,
    "periodStart" TIMESTAMPTZ,
    "periodEnd" TIMESTAMPTZ,
    "authoritativeBindingId" UUID,
    "valueSnapshotId" UUID,
    "lastSyncedAt" TIMESTAMPTZ,
    "valueCapturedAt" TIMESTAMPTZ,
    "lastSyncStatus" "UsageSyncStatus",
    "lastSyncError" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "usage_quotas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_bindings" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "quotaId" UUID NOT NULL,
    "source" "UsageSource" NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "connectionId" UUID,
    "collectorId" TEXT,
    "status" "BindingStatus" NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_bindings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_snapshots" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "quotaId" UUID NOT NULL,
    "bindingId" UUID NOT NULL,
    "capturedAt" TIMESTAMPTZ NOT NULL,
    "kindAtCapture" "UsageKind" NOT NULL,
    "unitAtCapture" TEXT NOT NULL,
    "value" DECIMAL(20,4) NOT NULL,
    "limitValueAtCapture" DECIMAL(20,4),
    "periodStart" TIMESTAMPTZ,
    "periodEnd" TIMESTAMPTZ,
    "deviceId" UUID,
    "raw" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_cycle_summaries" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "quotaId" UUID NOT NULL,
    "periodStart" TIMESTAMPTZ NOT NULL,
    "periodEnd" TIMESTAMPTZ NOT NULL,
    "finalValue" DECIMAL(20,4) NOT NULL,
    "limitValueAtClose" DECIMAL(20,4),
    "utilizationAtClose" DECIMAL(10,4),
    "unitAtClose" TEXT NOT NULL,
    "authoritativeBindingIdAtClose" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_cycle_summaries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_connections" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "providerId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "credentialKeyId" TEXT NOT NULL,
    "credentialCipher" BYTEA NOT NULL,
    "credentialIv" BYTEA NOT NULL,
    "credentialTag" BYTEA NOT NULL,
    "status" "ConnectionStatus" NOT NULL DEFAULT 'active',
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "lastSyncAt" TIMESTAMPTZ,
    "lastError" TEXT,
    "syncFailureCount" INTEGER NOT NULL DEFAULT 0,
    "nextSyncAt" TIMESTAMPTZ,
    "syncLeaseUntil" TIMESTAMPTZ,
    "syncLeaseToken" UUID,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "provider_connections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "usage_quotas_userId_kind_idx" ON "usage_quotas"("userId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "usage_quotas_subscriptionId_metric_key" ON "usage_quotas"("subscriptionId", "metric");

-- CreateIndex
CREATE INDEX "usage_bindings_userId_status_idx" ON "usage_bindings"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "usage_bindings_quotaId_source_sourceKey_key" ON "usage_bindings"("quotaId", "source", "sourceKey");

-- CreateIndex
CREATE INDEX "usage_snapshots_quotaId_capturedAt_idx" ON "usage_snapshots"("quotaId", "capturedAt");

-- CreateIndex
CREATE INDEX "usage_snapshots_userId_quotaId_idx" ON "usage_snapshots"("userId", "quotaId");

-- CreateIndex
CREATE INDEX "usage_cycle_summaries_userId_idx" ON "usage_cycle_summaries"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "usage_cycle_summaries_quotaId_periodStart_key" ON "usage_cycle_summaries"("quotaId", "periodStart");

-- CreateIndex
CREATE INDEX "provider_connections_userId_providerId_idx" ON "provider_connections"("userId", "providerId");

-- CreateIndex
CREATE INDEX "provider_connections_status_nextSyncAt_idx" ON "provider_connections"("status", "nextSyncAt");

-- AddForeignKey
ALTER TABLE "usage_quotas" ADD CONSTRAINT "usage_quotas_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_quotas" ADD CONSTRAINT "usage_quotas_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "subscriptions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_bindings" ADD CONSTRAINT "usage_bindings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_bindings" ADD CONSTRAINT "usage_bindings_quotaId_fkey" FOREIGN KEY ("quotaId") REFERENCES "usage_quotas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_bindings" ADD CONSTRAINT "usage_bindings_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "provider_connections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_snapshots" ADD CONSTRAINT "usage_snapshots_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_snapshots" ADD CONSTRAINT "usage_snapshots_quotaId_fkey" FOREIGN KEY ("quotaId") REFERENCES "usage_quotas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_snapshots" ADD CONSTRAINT "usage_snapshots_bindingId_fkey" FOREIGN KEY ("bindingId") REFERENCES "usage_bindings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_cycle_summaries" ADD CONSTRAINT "usage_cycle_summaries_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_cycle_summaries" ADD CONSTRAINT "usage_cycle_summaries_quotaId_fkey" FOREIGN KEY ("quotaId") REFERENCES "usage_quotas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_connections" ADD CONSTRAINT "provider_connections_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- M3 hand-written constraints
-- kind-conditional fields
ALTER TABLE "usage_quotas"
  ADD CONSTRAINT usage_quotas_kind_fields CHECK (
    ("kind" = 'quota' AND "limitValue" IS NOT NULL AND "usedValue" IS NOT NULL AND "periodStart" IS NOT NULL AND "periodEnd" IS NOT NULL)
    OR ("kind" = 'balance' AND "remainingValue" IS NOT NULL AND "limitValue" IS NULL AND "usedValue" IS NULL AND "resetCycle" = 'never')
    OR ("kind" = 'counter' AND "usedValue" IS NOT NULL AND "limitValue" IS NULL AND "remainingValue" IS NULL)
  );

-- binding must belong to the same user as quota; provider binding must match connection owner
CREATE OR REPLACE FUNCTION usage_binding_tenant_check() RETURNS trigger AS $$
DECLARE q usage_quotas%ROWTYPE;
DECLARE conn provider_connections%ROWTYPE;
BEGIN
  SELECT * INTO q FROM "usage_quotas" WHERE id = NEW."quotaId";
  IF q IS NULL OR q."userId" != NEW."userId" THEN
    RAISE EXCEPTION 'binding quota must belong to same user';
  END IF;
  IF NEW."connectionId" IS NOT NULL THEN
    SELECT * INTO conn FROM "provider_connections" WHERE id = NEW."connectionId";
    IF conn IS NULL OR conn."userId" != NEW."userId" THEN
      RAISE EXCEPTION 'binding connection must belong to same user';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS usage_binding_tenant_check_trigger ON "usage_bindings";
CREATE TRIGGER usage_binding_tenant_check_trigger
  BEFORE INSERT OR UPDATE OF "quotaId", "userId", "connectionId" ON "usage_bindings"
  FOR EACH ROW EXECUTE FUNCTION usage_binding_tenant_check();

-- snapshot idempotency (per binding+device+capturedAt) via expression unique index
CREATE UNIQUE INDEX usage_snapshots_idempotent
  ON "usage_snapshots" ("bindingId", COALESCE("deviceId", '00000000-0000-0000-0000-000000000000'::uuid), "capturedAt");

-- snapshot binding must belong to same user/quota
CREATE OR REPLACE FUNCTION usage_snapshot_tenant_check() RETURNS trigger AS $$
DECLARE b usage_bindings%ROWTYPE;
BEGIN
  SELECT * INTO b FROM "usage_bindings" WHERE id = NEW."bindingId";
  IF b IS NULL OR b."quotaId" != NEW."quotaId" OR b."userId" != NEW."userId" THEN
    RAISE EXCEPTION 'snapshot binding must belong to same quota and user';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS usage_snapshot_tenant_check_trigger ON "usage_snapshots";
CREATE TRIGGER usage_snapshot_tenant_check_trigger
  BEFORE INSERT OR UPDATE OF "bindingId", "quotaId", "userId" ON "usage_snapshots"
  FOR EACH ROW EXECUTE FUNCTION usage_snapshot_tenant_check();
