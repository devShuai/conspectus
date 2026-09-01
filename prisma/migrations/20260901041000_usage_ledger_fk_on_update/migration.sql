-- 四张流水账表的外键补 ON UPDATE CASCADE，与仓库里其余 users 外键一致。
--
-- 上一条迁移用了列内联的 `REFERENCES ... ON DELETE CASCADE`，Postgres 默认给
-- ON UPDATE NO ACTION；usage_ledger_days 从 #143 起就是这样。userId 是不可变的
-- uuid，这条规则实际永远不会触发 —— 修它只是为了少留四条无害但会一直出现在
-- `prisma migrate diff` 里的噪音。仓库里还有别的历史漂移（notification_* 的两条、
-- 各表 id 的 gen_random_uuid 默认值），本迁移不碰。

ALTER TABLE "usage_ledger_days" DROP CONSTRAINT "usage_ledger_days_userId_fkey";
ALTER TABLE "usage_ledger_days" ADD CONSTRAINT "usage_ledger_days_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "usage_ledger_sessions" DROP CONSTRAINT "usage_ledger_sessions_userId_fkey";
ALTER TABLE "usage_ledger_sessions" ADD CONSTRAINT "usage_ledger_sessions_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "usage_tool_stats" DROP CONSTRAINT "usage_tool_stats_userId_fkey";
ALTER TABLE "usage_tool_stats" ADD CONSTRAINT "usage_tool_stats_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "usage_model_quality" DROP CONSTRAINT "usage_model_quality_userId_fkey";
ALTER TABLE "usage_model_quality" ADD CONSTRAINT "usage_model_quality_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
