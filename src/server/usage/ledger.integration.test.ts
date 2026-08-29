import { beforeEach, describe, expect, it } from "vitest";

import { db } from "@/server/db";
import { ingestLedgerDays, type LedgerDay } from "./ledger";
import { loadLedgerView } from "./ledger-query";

const DISABLED = !process.env.TEST_DATABASE_URL;

function uniqueSub(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function row(overrides: Partial<LedgerDay> = {}): LedgerDay {
  return {
    day: "2026-08-18",
    provider: "claude",
    projectKey: "demo",
    model: "claude-opus-5",
    inputTokens: 10,
    outputTokens: 20,
    cacheReadTokens: 30,
    cacheWriteTokens: 40,
    apiCalls: 5,
    sessions: 1,
    costUsd: 1.5,
    ...overrides,
  };
}

describe.skipIf(DISABLED)("usage ledger (#143)", () => {
  let userId: string;

  beforeEach(async () => {
    const user = await db.user.create({
      data: {
        certusSub: uniqueSub("ledger"),
        certusLinkStatus: "active",
        lastStatusSyncedAt: new Date(),
        timezone: "UTC",
      },
    });
    userId = user.id;
  });

  /*
   * 采集器每轮上报的是「该日至今的累计值」，所以重复上报必须覆盖而非累加 ——
   * 累加会让数字随采集轮次成倍虚高，而 run 是小时级的。
   */
  it("overwrites rather than accumulates on repeated reports", async () => {
    await ingestLedgerDays(userId, [row({ costUsd: 1.5, apiCalls: 5 })]);
    await ingestLedgerDays(userId, [row({ costUsd: 4, apiCalls: 12 })]);

    const stored = await db.usageLedgerDay.findMany({ where: { userId } });
    expect(stored).toHaveLength(1);
    expect(Number(stored[0].costUsd)).toBe(4);
    expect(stored[0].apiCalls).toBe(12);

    await db.user.delete({ where: { id: userId } });
  });

  it("aggregates by provider, model and project with shares", async () => {
    await ingestLedgerDays(userId, [
      row({ model: "claude-opus-5", costUsd: 75 }),
      row({ model: "claude-fable-5", costUsd: 25 }),
      row({ projectKey: "other", model: "claude-opus-5", costUsd: 0, apiCalls: 1 }),
    ]);

    const view = await loadLedgerView(userId, "UTC", { from: "2026-08-01", to: "2026-08-31" });
    expect(view.totals.costUsd).toBe(100);
    expect(view.byModel.map((r) => r.key)).toEqual(["claude-opus-5", "claude-fable-5"]);
    expect(view.byModel[0].sharePct).toBeCloseTo(75, 5);
    expect(view.byProject.map((r) => r.key)).toEqual(["demo", "other"]);
    expect(view.daily).toHaveLength(1);

    await db.user.delete({ where: { id: userId } });
  });

  // 价格表缺该模型时成本全为 0，此时按 token 算占比，否则整列都是 0 看不出差别
  it("falls back to token share when every cost is zero", async () => {
    await ingestLedgerDays(userId, [
      row({ model: "a", costUsd: 0, inputTokens: 300, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }),
      row({ model: "b", costUsd: 0, inputTokens: 100, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }),
    ]);
    const view = await loadLedgerView(userId, "UTC", { from: "2026-08-01", to: "2026-08-31" });
    expect(view.byModel[0].key).toBe("a");
    expect(view.byModel[0].sharePct).toBeCloseTo(75, 5);

    await db.user.delete({ where: { id: userId } });
  });

  // 配额仪表盘与流水账彼此独立：没有流水账数据不该让查询报错
  it("returns empty totals for a user with no ledger rows", async () => {
    const view = await loadLedgerView(userId, "UTC");
    expect(view.totals).toEqual({ tokens: 0, costUsd: 0, apiCalls: 0, sessions: 0 });
    expect(view.lastCapturedAt).toBeNull();

    await db.user.delete({ where: { id: userId } });
  });
});
