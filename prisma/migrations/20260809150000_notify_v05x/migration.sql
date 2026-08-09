-- #116 / design v0.5.x（§7.6 字段清单）：
-- NotificationDelivery/NotificationDigest 补 deferredReason（可恢复门禁的结构化原因），
-- NotificationChannel 补 digestLocalTime（每日摘要的本地时刻，仅 email 使用）。
ALTER TABLE "notification_deliveries" ADD COLUMN IF NOT EXISTS "deferredReason" TEXT;
ALTER TABLE "notification_digests" ADD COLUMN IF NOT EXISTS "deferredReason" TEXT;
ALTER TABLE "notification_channels" ADD COLUMN IF NOT EXISTS "digestLocalTime" TIME(6);
