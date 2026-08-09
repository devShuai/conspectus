-- #125：certus#10 之后状态端点成对返回 email + email_verified，验证位可以直接与
-- 本地地址比对，「快照时间 + 需重新同步标记」这套启发式失去存在理由。
--
-- 两列都只服务于 updated_at 比较及其派生的等待逻辑，没有其他读者：
--   emailSnapshotIssuedAt —— 登录时记下的 ID Token iat
--   emailSyncRequiredAt   —— 比较判定「可能变过」后写入的等待标记
-- 该启发式误报率很高（certus 侧任何画像编辑都会 bump updated_at），删除它同时
-- 消除了「一次改显示名就静默停掉用户全部邮件通知」的路径。
--
-- 数据不需要迁移：残留的 emailSyncRequiredAt 只表示「等重新登录」，而新逻辑在
-- 下一轮投递前复核时就会用 certus 的成对响应重新判定。
ALTER TABLE "users" DROP COLUMN IF EXISTS "emailSnapshotIssuedAt";
ALTER TABLE "users" DROP COLUMN IF EXISTS "emailSyncRequiredAt";

-- 同理，因该启发式而延迟的行，其 deferredReason 已无对应门禁；清成 NULL 让它们
-- 按各自的退避重试正常恢复，而不是永远带着一个不再有人写入的原因。
UPDATE "notification_deliveries" SET "deferredReason" = NULL
  WHERE "deferredReason" = 'email_snapshot_stale';
UPDATE "notification_digests" SET "deferredReason" = NULL
  WHERE "deferredReason" = 'email_snapshot_stale';
