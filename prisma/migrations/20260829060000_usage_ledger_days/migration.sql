-- #143：消耗流水账的按日聚合。与 usage_quotas 的配额仪表盘并存，互不替代 ——
-- 配额值是 §7.6 通知机制的输入，而本地 token 求和还原不出服务端加权算出的百分比。
--
-- 只存按日聚合：本机单用户仅 claude 30 天就有 3502 条逐次明细，聚合后是数十行；
-- 明细留在本机由采集器保管。projectKey 存脱敏标识，不是本机路径。
CREATE TABLE "usage_ledger_days" (
  "id"               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId"           uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "day"              date NOT NULL,
  "provider"         text NOT NULL,
  "projectKey"       text NOT NULL,
  "model"            text NOT NULL,
  "inputTokens"      bigint NOT NULL DEFAULT 0,
  "outputTokens"     bigint NOT NULL DEFAULT 0,
  "cacheReadTokens"  bigint NOT NULL DEFAULT 0,
  "cacheWriteTokens" bigint NOT NULL DEFAULT 0,
  "apiCalls"         integer NOT NULL DEFAULT 0,
  "sessions"         integer NOT NULL DEFAULT 0,
  "costUsd"          numeric(14, 6) NOT NULL DEFAULT 0,
  "capturedAt"       timestamptz NOT NULL,
  "createdAt"        timestamptz NOT NULL DEFAULT now(),
  "updatedAt"        timestamptz NOT NULL
);

-- 上报是幂等 upsert：同一天同一 (provider, project, model) 重复上报只更新，不累加。
-- 采集器每轮上报的是「该日至今的累计值」，累加会随轮次翻倍。
CREATE UNIQUE INDEX "usage_ledger_days_unique"
  ON "usage_ledger_days" ("userId", "day", "provider", "projectKey", "model");

CREATE INDEX "usage_ledger_days_user_day" ON "usage_ledger_days" ("userId", "day");
CREATE INDEX "usage_ledger_days_user_provider_day"
  ON "usage_ledger_days" ("userId", "provider", "day");

-- 计数与成本不允许为负：来源是外部工具的导出，负值只可能是解析错误。
ALTER TABLE "usage_ledger_days" ADD CONSTRAINT "usage_ledger_days_non_negative" CHECK (
  "inputTokens" >= 0 AND "outputTokens" >= 0 AND "cacheReadTokens" >= 0
  AND "cacheWriteTokens" >= 0 AND "apiCalls" >= 0 AND "sessions" >= 0 AND "costUsd" >= 0
);
