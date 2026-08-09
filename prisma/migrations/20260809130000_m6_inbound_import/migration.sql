-- M6 邮件导入（#57，design §6.2 / §7.5）：入站审计 InboundEmail 与导入草稿
-- ImportDraft。部分约束超出 Prisma 表达力，以本文件手写 SQL 为准（§6.2 实现注记）。

-- CreateEnum
CREATE TYPE "InboundEmailParseStatus" AS ENUM ('pending', 'parsed', 'failed');

-- CreateEnum
CREATE TYPE "ImportDraftSource" AS ENUM ('email', 'csv');

-- CreateEnum
CREATE TYPE "ImportDraftStatus" AS ENUM ('pending', 'accepted', 'rejected', 'expired');

-- AlterTable
-- 用户可关闭邮件原文保留（§7.5/§9）；既有用户默认保留（30 天自动清除不变）
ALTER TABLE "users" ADD COLUMN "inboundRetainRaw" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "inbound_emails" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "messageId" TEXT NOT NULL,
    "fromAddr" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "receivedAt" TIMESTAMPTZ NOT NULL,
    "parseStatus" "InboundEmailParseStatus" NOT NULL DEFAULT 'pending',
    "rawCipher" BYTEA,
    "rawRetainedUntil" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inbound_emails_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_drafts" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "source" "ImportDraftSource" NOT NULL,
    "payload" JSONB NOT NULL,
    "confidence" DECIMAL(4,3) NOT NULL,
    "status" "ImportDraftStatus" NOT NULL DEFAULT 'pending',
    "suggestedSubscriptionId" UUID,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "import_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "inbound_emails_userId_messageId_key" ON "inbound_emails"("userId", "messageId");

-- CreateIndex
CREATE INDEX "inbound_emails_rawRetainedUntil_idx" ON "inbound_emails"("rawRetainedUntil");

-- CreateIndex
CREATE INDEX "import_drafts_userId_status_idx" ON "import_drafts"("userId", "status");

-- CreateIndex
CREATE INDEX "import_drafts_expiresAt_idx" ON "import_drafts"("expiresAt");

-- AddForeignKey
ALTER TABLE "inbound_emails" ADD CONSTRAINT "inbound_emails_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_drafts" ADD CONSTRAINT "import_drafts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_drafts" ADD CONSTRAINT "import_drafts_suggestedSubscriptionId_fkey" FOREIGN KEY ("suggestedSubscriptionId") REFERENCES "subscriptions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- #57 hand-written constraints
-- confidence 是 0..1 的置信度（0.9 为 UI 预选阈值，§7.5）
ALTER TABLE "import_drafts"
  ADD CONSTRAINT import_drafts_confidence_range
  CHECK ("confidence" >= 0 AND "confidence" <= 1);

-- 原文保留期限与原文同生同灭：rawCipher 非空时 rawRetainedUntil 必填，
-- purge 按 rawRetainedUntil 置空原文（§5.4）
ALTER TABLE "inbound_emails"
  ADD CONSTRAINT inbound_emails_raw_retention
  CHECK ("rawCipher" IS NULL OR "rawRetainedUntil" IS NOT NULL);

-- 草稿的候选订阅必须属于同一用户（租户外键规则 §6.2；沿用 #102 触发器模式，
-- 被引用订阅删除时由外键 ON DELETE SET NULL 清空建议，草稿本身保留）
CREATE OR REPLACE FUNCTION import_draft_tenant_check() RETURNS trigger AS $$
DECLARE s subscriptions%ROWTYPE;
BEGIN
  IF NEW."suggestedSubscriptionId" IS NOT NULL THEN
    SELECT * INTO s FROM "subscriptions" WHERE id = NEW."suggestedSubscriptionId";
    IF s IS NULL OR s."userId" != NEW."userId" THEN
      RAISE EXCEPTION 'import draft suggested subscription must belong to same user';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS import_draft_tenant_check_trigger ON "import_drafts";
CREATE TRIGGER import_draft_tenant_check_trigger
  BEFORE INSERT OR UPDATE OF "suggestedSubscriptionId", "userId" ON "import_drafts"
  FOR EACH ROW EXECUTE FUNCTION import_draft_tenant_check();
