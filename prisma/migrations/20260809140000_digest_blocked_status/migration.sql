-- #91：Digest 终态补 blocked（design §7.6「已知未验证时 Digest 与子 Delivery 一并 blocked」），
-- 与 NotificationDeliveryStatus 对齐；原来只能退而求其次落 failed，语义错误（failed 是外呼失败）。
ALTER TYPE "NotificationDigestStatus" ADD VALUE IF NOT EXISTS 'blocked';
