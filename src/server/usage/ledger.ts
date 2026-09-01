import { z } from "zod";

import { db } from "@/server/db";

/**
 * 消耗流水账的上报契约与写入（#143）。
 *
 * 与 UsageReading 是两种东西，因此走独立通道：读数回答「这条额度现在是多少」，
 * 流水账回答「这天在这个项目、这个模型上消耗了多少」。硬塞进同一个契约会把 §4
 * 要求分开建模的计量模型再次搅在一起。
 *
 * 载荷有四张表，对应 codeburn 导出的四个维度（按日聚合 / 每会话 / 工具与 MCP /
 * 按模型的质量指标）。前者是时间序列，后三者是 30 天窗口的**快照** —— codeburn
 * 只给窗口合计，没有日维度可存，所以写入方式也不同，见下面各自的注释。
 */

const NON_NEGATIVE_INT = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);

const MONEY = z.number().nonnegative().finite();
const PERCENT = z.number().nonnegative().finite().max(1000);

export const LedgerDaySchema = z.object({
  /** 本地日期 YYYY-MM-DD，由采集器按用户机器时区切分。 */
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  provider: z.string().min(1).max(64),
  /** 脱敏后的项目标识；无项目维度的来源传空串。 */
  projectKey: z.string().max(200),
  model: z.string().min(1).max(128),
  /** codeburn 的任务分类；来源没有该维度时传空串。 */
  category: z.string().max(64).default(""),
  /** 子代理类型；无则空串。 */
  subagent: z.string().max(64).default(""),
  inputTokens: NON_NEGATIVE_INT,
  outputTokens: NON_NEGATIVE_INT,
  reasoningTokens: NON_NEGATIVE_INT.default(0),
  cacheReadTokens: NON_NEGATIVE_INT,
  cacheWriteTokens: NON_NEGATIVE_INT,
  apiCalls: NON_NEGATIVE_INT,
  sessions: NON_NEGATIVE_INT,
  costUsd: MONEY,
  savedUsd: MONEY.default(0),
});

export const LedgerSessionSchema = z.object({
  sessionId: z.string().min(1).max(128),
  projectKey: z.string().max(200),
  provider: z.string().max(64),
  startedAt: z.string().datetime(),
  costUsd: MONEY,
  savedUsd: MONEY.default(0),
  apiCalls: NON_NEGATIVE_INT,
  turns: NON_NEGATIVE_INT,
});

export const LedgerToolSchema = z.object({
  kind: z.enum(["tool", "mcp"]),
  name: z.string().min(1).max(128),
  calls: NON_NEGATIVE_INT,
  sharePct: PERCENT,
});

export const LedgerModelQualitySchema = z.object({
  model: z.string().min(1).max(128),
  costUsd: MONEY,
  savedUsd: MONEY.default(0),
  sharePct: PERCENT,
  apiCalls: NON_NEGATIVE_INT,
  editTurns: NON_NEGATIVE_INT,
  oneShotRatePct: PERCENT,
  retriesPerEdit: z.number().nonnegative().finite(),
  costPerEditUsd: MONEY,
});

export type LedgerDay = z.infer<typeof LedgerDaySchema>;
export type LedgerSession = z.infer<typeof LedgerSessionSchema>;
export type LedgerTool = z.infer<typeof LedgerToolSchema>;
export type LedgerModelQuality = z.infer<typeof LedgerModelQualitySchema>;

/**
 * 单次上报的行数上限。加上任务分类与子代理两个维度后，本机实测 6 个来源 30 天
 * 是 213 行；留足余量，但仍要有上限 —— 没有上限的批量写入是一条 DoS 通道。
 */
export const LEDGER_ROWS_LIMIT = 5000;
export const LEDGER_SESSIONS_LIMIT = 2000;
export const LEDGER_TOOLS_LIMIT = 500;
export const LEDGER_MODELS_LIMIT = 200;

export interface LedgerIngestResult {
  accepted: number;
  sessions: number;
  tools: number;
  models: number;
  rejected: Array<{ index: number; reason: string }>;
}

export interface LedgerPayload {
  days: LedgerDay[];
  sessions?: LedgerSession[];
  tools?: LedgerTool[];
  models?: LedgerModelQuality[];
}

/**
 * 写入一次上报。
 *
 * **按日聚合用「窗口替换」而不是逐行 upsert**。采集器每轮给的是同一个 30 天滚动
 * 窗口的重新计算结果，逐行 upsert 会留下两类僵尸行：
 *
 * 1. 维度变了的旧行。0.4.x 写的行 category 为空串，新版按分类拆开写；两者唯一键
 *    不同，旧行会永远留着，与新行一起被求和 —— 同一笔消耗算两次。
 * 2. 消失了的组合。某天某项目的记录被 codeburn 重新归类后不再产生该组合，旧行
 *    没人删。
 *
 * 替换范围严格限定在「本批次出现过的 provider × 本批次的日期区间」：这样另一台
 * 设备上报的其他来源不会被误删。
 *
 * 后三张表是整表替换（限该用户）：它们是窗口快照，没有增量语义。
 */
export async function ingestLedger(
  userId: string,
  payload: LedgerPayload,
  capturedAt: Date = new Date(),
): Promise<LedgerIngestResult> {
  const rejected: LedgerIngestResult["rejected"] = [];
  const rows: Array<LedgerDay & { dayDate: Date }> = [];

  for (const [index, row] of payload.days.entries()) {
    const dayDate = new Date(`${row.day}T00:00:00Z`);
    if (Number.isNaN(dayDate.getTime())) {
      rejected.push({ index, reason: "invalid_day" });
      continue;
    }
    rows.push({ ...row, dayDate });
  }

  const providers = [...new Set(rows.map((row) => row.provider))];
  const days = rows.map((row) => row.dayDate.getTime());
  const from = days.length > 0 ? new Date(Math.min(...days)) : null;
  const to = days.length > 0 ? new Date(Math.max(...days)) : null;

  const sessions = payload.sessions ?? [];
  const tools = payload.tools ?? [];
  const models = payload.models ?? [];

  // 一个事务：替换过程中途失败不能留下「删了旧的、没写新的」的空窗
  await db.$transaction(async (tx) => {
    if (from && to && providers.length > 0) {
      await tx.usageLedgerDay.deleteMany({
        where: { userId, provider: { in: providers }, day: { gte: from, lte: to } },
      });
      await tx.usageLedgerDay.createMany({
        data: rows.map((row) => ({
          userId,
          day: row.dayDate,
          provider: row.provider,
          projectKey: row.projectKey,
          model: row.model,
          category: row.category,
          subagent: row.subagent,
          inputTokens: BigInt(row.inputTokens),
          outputTokens: BigInt(row.outputTokens),
          reasoningTokens: BigInt(row.reasoningTokens),
          cacheReadTokens: BigInt(row.cacheReadTokens),
          cacheWriteTokens: BigInt(row.cacheWriteTokens),
          apiCalls: row.apiCalls,
          sessions: row.sessions,
          costUsd: row.costUsd,
          savedUsd: row.savedUsd,
          capturedAt,
        })),
      });
    }

    // 快照表：只在本次确实带了数据时替换。空数组按「本轮没采到」处理，
    // 保留上一次的快照，而不是把页面清空。
    if (sessions.length > 0) {
      await tx.usageLedgerSession.deleteMany({ where: { userId } });
      await tx.usageLedgerSession.createMany({
        data: sessions.map((row) => ({
          userId,
          sessionId: row.sessionId,
          projectKey: row.projectKey,
          provider: row.provider,
          startedAt: new Date(row.startedAt),
          costUsd: row.costUsd,
          savedUsd: row.savedUsd,
          apiCalls: row.apiCalls,
          turns: row.turns,
          capturedAt,
        })),
      });
    }

    if (tools.length > 0) {
      await tx.usageToolStat.deleteMany({ where: { userId } });
      await tx.usageToolStat.createMany({
        data: tools.map((row) => ({
          userId,
          kind: row.kind,
          name: row.name,
          calls: row.calls,
          sharePct: row.sharePct,
          capturedAt,
        })),
      });
    }

    if (models.length > 0) {
      await tx.usageModelQuality.deleteMany({ where: { userId } });
      await tx.usageModelQuality.createMany({
        data: models.map((row) => ({
          userId,
          model: row.model,
          costUsd: row.costUsd,
          savedUsd: row.savedUsd,
          sharePct: row.sharePct,
          apiCalls: row.apiCalls,
          editTurns: row.editTurns,
          oneShotRatePct: row.oneShotRatePct,
          retriesPerEdit: row.retriesPerEdit,
          costPerEditUsd: row.costPerEditUsd,
          capturedAt,
        })),
      });
    }
  });

  return {
    accepted: rows.length,
    sessions: sessions.length,
    tools: tools.length,
    models: models.length,
    rejected,
  };
}

/** 只写按日聚合的旧入口，保留给既有测试与只带 days 的上报。 */
export async function ingestLedgerDays(
  userId: string,
  rows: LedgerDay[],
  capturedAt: Date = new Date(),
): Promise<LedgerIngestResult> {
  return ingestLedger(userId, { days: rows }, capturedAt);
}
