-- CreateEnum
CREATE TYPE "BillingRecordType" AS ENUM ('charge', 'refund');

-- CreateEnum
CREATE TYPE "BillingRecordStatus" AS ENUM ('paid', 'pending', 'failed', 'void');

-- CreateEnum
CREATE TYPE "BillingRecordSource" AS ENUM ('manual', 'email', 'csv', 'system');

-- CreateEnum
CREATE TYPE "PaymentMethodKind" AS ENUM ('credit_card', 'debit_card', 'alipay', 'wechat', 'paypal', 'other');

-- CreateTable
CREATE TABLE "billing_records" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "subscriptionId" UUID NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "recordType" "BillingRecordType" NOT NULL,
    "originalRecordId" UUID,
    "billedAt" DATE NOT NULL,
    "periodStart" DATE,
    "periodEnd" DATE,
    "status" "BillingRecordStatus" NOT NULL,
    "source" "BillingRecordSource" NOT NULL,
    "externalRef" TEXT,
    "occurrenceKey" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "billing_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_conversions" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "billingRecordId" UUID NOT NULL,
    "baseCurrency" CHAR(3) NOT NULL,
    "signedAmountInBase" DECIMAL(14,2) NOT NULL,
    "fxRate" DECIMAL(18,8) NOT NULL,
    "fxDate" DATE NOT NULL,
    "rateSource" TEXT NOT NULL DEFAULT 'provider',
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_conversions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_methods" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "kind" "PaymentMethodKind" NOT NULL,
    "last4" CHAR(4),
    "expiresAt" DATE,
    "notes" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "payment_methods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exchange_rates" (
    "date" DATE NOT NULL,
    "base" CHAR(3) NOT NULL,
    "quote" CHAR(3) NOT NULL,
    "rate" DECIMAL(18,8) NOT NULL,

    CONSTRAINT "exchange_rates_pkey" PRIMARY KEY ("date","base","quote")
);

-- CreateTable
CREATE TABLE "currency_rebase_jobs" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "fromCurrency" CHAR(3) NOT NULL,
    "toCurrency" CHAR(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "totalCount" INTEGER NOT NULL DEFAULT 0,
    "doneCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "currency_rebase_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "billing_records_occurrenceKey_key" ON "billing_records"("occurrenceKey");

-- CreateIndex
CREATE INDEX "billing_records_userId_subscriptionId_recordType_idx" ON "billing_records"("userId", "subscriptionId", "recordType");

-- CreateIndex
CREATE INDEX "billing_records_userId_billedAt_idx" ON "billing_records"("userId", "billedAt");

-- CreateIndex
CREATE INDEX "billing_records_subscriptionId_occurrenceKey_idx" ON "billing_records"("subscriptionId", "occurrenceKey");

-- CreateIndex
CREATE UNIQUE INDEX "billing_records_userId_externalRef_key" ON "billing_records"("userId", "externalRef");

-- CreateIndex
CREATE INDEX "billing_conversions_userId_baseCurrency_idx" ON "billing_conversions"("userId", "baseCurrency");

-- CreateIndex
CREATE UNIQUE INDEX "billing_conversions_billingRecordId_baseCurrency_key" ON "billing_conversions"("billingRecordId", "baseCurrency");

-- CreateIndex
CREATE INDEX "payment_methods_userId_idx" ON "payment_methods"("userId");

-- CreateIndex
CREATE INDEX "currency_rebase_jobs_userId_status_idx" ON "currency_rebase_jobs"("userId", "status");

-- CreateIndex
CREATE INDEX "currency_rebase_jobs_status_idx" ON "currency_rebase_jobs"("status");

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_paymentMethodId_fkey" FOREIGN KEY ("paymentMethodId") REFERENCES "payment_methods"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_records" ADD CONSTRAINT "billing_records_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_records" ADD CONSTRAINT "billing_records_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "subscriptions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_records" ADD CONSTRAINT "billing_records_originalRecordId_fkey" FOREIGN KEY ("originalRecordId") REFERENCES "billing_records"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_conversions" ADD CONSTRAINT "billing_conversions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_conversions" ADD CONSTRAINT "billing_conversions_billingRecordId_fkey" FOREIGN KEY ("billingRecordId") REFERENCES "billing_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_methods" ADD CONSTRAINT "payment_methods_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "currency_rebase_jobs" ADD CONSTRAINT "currency_rebase_jobs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- M2 hand-written constraints
-- refund must point to a paid charge of the same user/subscription/currency
CREATE OR REPLACE FUNCTION billing_refund_valid() RETURNS trigger AS $$
DECLARE original billing_records%ROWTYPE;
BEGIN
  IF NEW."recordType" = 'charge' THEN
    IF NEW."originalRecordId" IS NOT NULL THEN
      RAISE EXCEPTION 'charge must not reference an original record';
    END IF;
    RETURN NEW;
  END IF;
  -- refund
  IF NEW."originalRecordId" IS NULL THEN
    RAISE EXCEPTION 'refund requires originalRecordId';
  END IF;
  SELECT * INTO original FROM "billing_records"
    WHERE id = NEW."originalRecordId";
  IF original IS NULL OR original."recordType" != 'charge' OR original."status" != 'paid' THEN
    RAISE EXCEPTION 'refund must reference a paid charge';
  END IF;
  IF original."userId" != NEW."userId" OR original."subscriptionId" != NEW."subscriptionId" OR original."currency" != NEW."currency" THEN
    RAISE EXCEPTION 'refund must match user, subscription and currency of original';
  END IF;
  -- refund total must not exceed original amount
  DECLARE total NUMERIC(14,2);
  BEGIN
    SELECT COALESCE(SUM(amount), 0) INTO total FROM "billing_records"
      WHERE "originalRecordId" = original.id AND "recordType" = 'refund' AND status = 'paid'
        AND id <> NEW.id;
    IF total + NEW.amount > original.amount THEN
      RAISE EXCEPTION 'refund total exceeds original charge';
    END IF;
  END;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS billing_refund_valid_trigger ON "billing_records";
CREATE TRIGGER billing_refund_valid_trigger
  BEFORE INSERT OR UPDATE OF "recordType", "originalRecordId", "amount", "status", "userId", "subscriptionId", "currency"
  ON "billing_records"
  FOR EACH ROW EXECUTE FUNCTION billing_refund_valid();

-- pending/refund must not project (projections only for established facts)
CREATE OR REPLACE FUNCTION billing_projection_guard() RETURNS trigger AS $$
DECLARE rec billing_records%ROWTYPE;
BEGIN
  SELECT * INTO rec FROM "billing_records" WHERE id = NEW."billingRecordId";
  IF rec IS NULL OR rec."status" != 'paid' THEN
    RAISE EXCEPTION 'conversion only allowed for paid billing records';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS billing_projection_guard_trigger ON "billing_conversions";
CREATE TRIGGER billing_projection_guard_trigger
  BEFORE INSERT OR UPDATE OF "billingRecordId" ON "billing_conversions"
  FOR EACH ROW EXECUTE FUNCTION billing_projection_guard();

-- one active rebase job per user
CREATE UNIQUE INDEX currency_rebase_jobs_one_active
  ON "currency_rebase_jobs" ("userId")
  WHERE "status" IN ('pending', 'running');
