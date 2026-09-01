-- 消耗流水账补齐 codeburn 的完整口径。0.4.x 的采集只跑了 `--provider claude`
-- 并且丢掉了推理 token、任务分类、节省额与全部明细表 —— 本机实测那等于把 6 个
-- 来源里的 5 个、31277 条调用里的绝大部分信息扔掉。
--
-- 新增列都有默认值，旧行不需要回填：它们会在下一次上报时被窗口替换（见
-- src/server/usage/ledger.ts 的 ingestLedgerDays）。

ALTER TABLE "usage_ledger_days"
  -- codeburn 的招牌维度：coding / debugging / delegation / exploration …
  ADD COLUMN "category"        text NOT NULL DEFAULT '',
  -- 委派给子代理时的代理类型；codeburn 只在 delegation 场景写这个字段
  ADD COLUMN "subagent"        text NOT NULL DEFAULT '',
  -- 推理 token：本机 31277 条调用里 20556 条非零，是 codex / grok 的成本大头
  ADD COLUMN "reasoningTokens" bigint NOT NULL DEFAULT 0,
  -- 本地模型 / 订阅代理折算出的「省下多少」，codeburn 与实付成本分开记
  ADD COLUMN "savedUsd"        numeric(14, 6) NOT NULL DEFAULT 0;

-- 唯一键加上两个新维度。旧唯一键是新键的前缀，已有行不可能因此冲突。
DROP INDEX "usage_ledger_days_unique";
CREATE UNIQUE INDEX "usage_ledger_days_unique" ON "usage_ledger_days" (
  "userId", "day", "provider", "projectKey", "model", "category", "subagent"
);

-- 非负约束覆盖新列：来源是外部工具的导出，负值只可能是解析错误。
ALTER TABLE "usage_ledger_days" DROP CONSTRAINT "usage_ledger_days_non_negative";
ALTER TABLE "usage_ledger_days" ADD CONSTRAINT "usage_ledger_days_non_negative" CHECK (
  "inputTokens" >= 0 AND "outputTokens" >= 0 AND "reasoningTokens" >= 0
  AND "cacheReadTokens" >= 0 AND "cacheWriteTokens" >= 0
  AND "apiCalls" >= 0 AND "sessions" >= 0
  AND "costUsd" >= 0 AND "savedUsd" >= 0
);

-- 以下三张表都是**快照**而非时间序列：codeburn 每次导出给的是同一个 30 天滚动
-- 窗口的合计，没有日维度可存。上报时整体替换该用户的行，不做增量累加。

CREATE TABLE "usage_ledger_sessions" (
  "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId"     uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "sessionId"  text NOT NULL,
  "projectKey" text NOT NULL,
  "provider"   text NOT NULL,
  "startedAt"  timestamptz NOT NULL,
  "costUsd"    numeric(14, 6) NOT NULL DEFAULT 0,
  "savedUsd"   numeric(14, 6) NOT NULL DEFAULT 0,
  "apiCalls"   integer NOT NULL DEFAULT 0,
  "turns"      integer NOT NULL DEFAULT 0,
  "capturedAt" timestamptz NOT NULL,
  "createdAt"  timestamptz NOT NULL DEFAULT now(),
  "updatedAt"  timestamptz NOT NULL
);

CREATE UNIQUE INDEX "usage_ledger_sessions_userId_sessionId_key"
  ON "usage_ledger_sessions" ("userId", "sessionId");
CREATE INDEX "usage_ledger_sessions_userId_startedAt_idx"
  ON "usage_ledger_sessions" ("userId", "startedAt");

ALTER TABLE "usage_ledger_sessions" ADD CONSTRAINT "usage_ledger_sessions_non_negative" CHECK (
  "costUsd" >= 0 AND "savedUsd" >= 0 AND "apiCalls" >= 0 AND "turns" >= 0
);

CREATE TABLE "usage_tool_stats" (
  "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId"     uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  -- tool | mcp
  "kind"       text NOT NULL,
  "name"       text NOT NULL,
  "calls"      integer NOT NULL DEFAULT 0,
  "sharePct"   numeric(6, 2) NOT NULL DEFAULT 0,
  "capturedAt" timestamptz NOT NULL,
  "createdAt"  timestamptz NOT NULL DEFAULT now(),
  "updatedAt"  timestamptz NOT NULL
);

CREATE UNIQUE INDEX "usage_tool_stats_userId_kind_name_key"
  ON "usage_tool_stats" ("userId", "kind", "name");
CREATE INDEX "usage_tool_stats_userId_kind_idx" ON "usage_tool_stats" ("userId", "kind");

-- kind 只有两种取值；写错会让「按工具」和「按 MCP」两块互相串台，宁可写不进去。
ALTER TABLE "usage_tool_stats" ADD CONSTRAINT "usage_tool_stats_kind" CHECK (
  "kind" IN ('tool', 'mcp')
);
ALTER TABLE "usage_tool_stats" ADD CONSTRAINT "usage_tool_stats_non_negative" CHECK (
  "calls" >= 0 AND "sharePct" >= 0
);

CREATE TABLE "usage_model_quality" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId"         uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  -- codeburn 的展示名（如 `Opus 5`），与 usage_ledger_days.model 的原始 id
  -- 不是同一个键，故意不做外键 —— 强行 join 会在改名时静默丢行。
  "model"          text NOT NULL,
  "costUsd"        numeric(14, 6) NOT NULL DEFAULT 0,
  "savedUsd"       numeric(14, 6) NOT NULL DEFAULT 0,
  "sharePct"       numeric(6, 2) NOT NULL DEFAULT 0,
  "apiCalls"       integer NOT NULL DEFAULT 0,
  "editTurns"      integer NOT NULL DEFAULT 0,
  "oneShotRatePct" numeric(6, 2) NOT NULL DEFAULT 0,
  "retriesPerEdit" numeric(10, 2) NOT NULL DEFAULT 0,
  "costPerEditUsd" numeric(14, 6) NOT NULL DEFAULT 0,
  "capturedAt"     timestamptz NOT NULL,
  "createdAt"      timestamptz NOT NULL DEFAULT now(),
  "updatedAt"      timestamptz NOT NULL
);

CREATE UNIQUE INDEX "usage_model_quality_userId_model_key"
  ON "usage_model_quality" ("userId", "model");

ALTER TABLE "usage_model_quality" ADD CONSTRAINT "usage_model_quality_non_negative" CHECK (
  "costUsd" >= 0 AND "savedUsd" >= 0 AND "sharePct" >= 0 AND "apiCalls" >= 0
  AND "editTurns" >= 0 AND "oneShotRatePct" >= 0 AND "retriesPerEdit" >= 0
  AND "costPerEditUsd" >= 0
);
