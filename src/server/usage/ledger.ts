import { z } from "zod";

import { db } from "@/server/db";

/**
 * 消耗流水账的上报契约与写入（#143）。
 *
 * 与 UsageReading 是两种东西，因此走独立通道：读数回答「这条额度现在是多少」，
 * 流水账回答「这天在这个项目、这个模型上消耗了多少」。硬塞进同一个契约会把 §4
 * 要求分开建模的计量模型再次搅在一起。
 */

const NON_NEGATIVE_INT = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);

export const LedgerDaySchema = z.object({
  /** 本地日期 YYYY-MM-DD，由采集器按用户机器时区切分。 */
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  provider: z.string().min(1).max(64),
  /** 脱敏后的项目标识；无项目维度的来源传空串。 */
  projectKey: z.string().max(200),
  model: z.string().min(1).max(128),
  inputTokens: NON_NEGATIVE_INT,
  outputTokens: NON_NEGATIVE_INT,
  cacheReadTokens: NON_NEGATIVE_INT,
  cacheWriteTokens: NON_NEGATIVE_INT,
  apiCalls: NON_NEGATIVE_INT,
  sessions: NON_NEGATIVE_INT,
  costUsd: z.number().nonnegative().finite(),
});

export type LedgerDay = z.infer<typeof LedgerDaySchema>;

/** 单次上报的行数上限：按日 × provider × 项目 × 模型，30 天窗口下数十行是常态。 */
export const LEDGER_ROWS_LIMIT = 2000;

export interface LedgerIngestResult {
  accepted: number;
  rejected: Array<{ index: number; reason: string }>;
}

/**
 * 幂等 upsert。采集器每轮上报的是「该日至今的累计值」，所以重复上报必须**覆盖**
 * 而不是累加 —— 累加会随采集轮次成倍虚高。唯一键是
 * (userId, day, provider, projectKey, model)。
 */
export async function ingestLedgerDays(
  userId: string,
  rows: LedgerDay[],
  capturedAt: Date = new Date(),
): Promise<LedgerIngestResult> {
  const rejected: LedgerIngestResult["rejected"] = [];
  let accepted = 0;

  for (const [index, row] of rows.entries()) {
    const day = new Date(`${row.day}T00:00:00Z`);
    if (Number.isNaN(day.getTime())) {
      rejected.push({ index, reason: "invalid_day" });
      continue;
    }
    const values = {
      inputTokens: BigInt(row.inputTokens),
      outputTokens: BigInt(row.outputTokens),
      cacheReadTokens: BigInt(row.cacheReadTokens),
      cacheWriteTokens: BigInt(row.cacheWriteTokens),
      apiCalls: row.apiCalls,
      sessions: row.sessions,
      costUsd: row.costUsd,
      capturedAt,
    };
    try {
      await db.usageLedgerDay.upsert({
        where: {
          userId_day_provider_projectKey_model: {
            userId,
            day,
            provider: row.provider,
            projectKey: row.projectKey,
            model: row.model,
          },
        },
        create: {
          userId,
          day,
          provider: row.provider,
          projectKey: row.projectKey,
          model: row.model,
          ...values,
        },
        update: values,
      });
      accepted++;
    } catch {
      // 单行失败不拖垮整批：一行解析异常不该让其余几十行一起丢
      rejected.push({ index, reason: "write_failed" });
    }
  }
  return { accepted, rejected };
}
