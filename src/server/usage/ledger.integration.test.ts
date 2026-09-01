import { beforeEach, describe, expect, it } from "vitest";

import { db } from "@/server/db";
import { ingestLedger, ingestLedgerDays, type LedgerDay } from "./ledger";
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
    category: "coding",
    subagent: "",
    inputTokens: 10,
    outputTokens: 20,
    reasoningTokens: 7,
    cacheReadTokens: 30,
    cacheWriteTokens: 40,
    apiCalls: 5,
    sessions: 1,
    costUsd: 1.5,
    savedUsd: 0,
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
    expect(view.totals).toEqual({
      tokens: 0,
      costUsd: 0,
      savedUsd: 0,
      apiCalls: 0,
      reasoningTokens: 0,
    });
    expect(view.sessionCount).toBe(0);
    expect(view.lastCapturedAt).toBeNull();

    await db.user.delete({ where: { id: userId } });
  });

  /*
   * 0.4.x 写的行 category 为空串，新版按分类拆开写。两者唯一键不同，如果只做逐行
   * upsert，旧行会永远留着并与新行一起被求和 —— 同一笔消耗算两次。窗口替换必须把
   * 它清掉。
   */
  it("purges rows whose dimensions changed instead of double counting", async () => {
    await ingestLedgerDays(userId, [row({ category: "", costUsd: 10, apiCalls: 4 })]);
    await ingestLedgerDays(userId, [row({ category: "coding", costUsd: 10, apiCalls: 4 })]);

    const stored = await db.usageLedgerDay.findMany({ where: { userId } });
    expect(stored).toHaveLength(1);
    expect(stored[0].category).toBe("coding");

    const view = await loadLedgerView(userId, "UTC", { from: "2026-08-01", to: "2026-08-31" });
    expect(view.totals.costUsd).toBe(10);
    expect(view.totals.apiCalls).toBe(4);

    await db.user.delete({ where: { id: userId } });
  });

  // 替换范围只限本批次出现过的 provider，否则另一台设备上报的来源会被误删
  it("leaves providers absent from the batch untouched", async () => {
    await ingestLedgerDays(userId, [row({ provider: "codex", costUsd: 7 })]);
    await ingestLedgerDays(userId, [row({ provider: "claude", costUsd: 3 })]);

    const view = await loadLedgerView(userId, "UTC", { from: "2026-08-01", to: "2026-08-31" });
    expect(view.byProvider.map((r) => r.key).sort()).toEqual(["claude", "codex"]);
    expect(view.totals.costUsd).toBe(10);

    await db.user.delete({ where: { id: userId } });
  });

  it("splits the task-category dimension and reports reasoning separately", async () => {
    await ingestLedgerDays(userId, [
      row({ category: "coding", costUsd: 60, reasoningTokens: 100 }),
      row({ category: "debugging", costUsd: 40, reasoningTokens: 50 }),
    ]);

    const view = await loadLedgerView(userId, "UTC", { from: "2026-08-01", to: "2026-08-31" });
    expect(view.byCategory.map((r) => r.key)).toEqual(["coding", "debugging"]);
    expect(view.byCategory[0].sharePct).toBeCloseTo(60, 5);
    expect(view.totals.reasoningTokens).toBe(150);
    // 推理 token 不进 tokens 总数：不同来源语义不同，合并会把 codex 算重
    expect(view.totals.tokens).toBe(200);

    await db.user.delete({ where: { id: userId } });
  });

  /*
   * 同一个会话会横跨多天、多模型、多个任务分类的行；把按日聚合行里的 sessions
   * 相加会重复计数（真实数据里 32 个会话被加成 220）。会话数只能来自会话快照表。
   */
  it("counts sessions from the snapshot rather than summing daily rows", async () => {
    await ingestLedger(userId, {
      days: [
        row({ day: "2026-08-18", model: "a", sessions: 1 }),
        row({ day: "2026-08-19", model: "a", sessions: 1 }),
        row({ day: "2026-08-19", model: "b", sessions: 1 }),
      ],
      sessions: [
        {
          sessionId: "only-one",
          projectKey: "demo",
          provider: "claude",
          startedAt: "2026-08-18T09:00:00.000Z",
          costUsd: 5,
          savedUsd: 0,
          apiCalls: 10,
          turns: 3,
        },
      ],
    });

    const view = await loadLedgerView(userId, "UTC", { from: "2026-08-01", to: "2026-08-31" });
    expect(view.sessionCount).toBe(1);

    await db.user.delete({ where: { id: userId } });
  });

  it("replaces snapshot tables wholesale but keeps them when a report omits them", async () => {
    await ingestLedger(userId, {
      days: [row()],
      sessions: [
        {
          sessionId: "s-1",
          projectKey: "demo",
          provider: "claude",
          startedAt: "2026-08-18T09:00:00.000Z",
          costUsd: 5,
          savedUsd: 0,
          apiCalls: 10,
          turns: 3,
        },
      ],
      tools: [{ kind: "tool", name: "Bash", calls: 9, sharePct: 90 }],
      models: [
        {
          model: "Opus 5",
          costUsd: 5,
          savedUsd: 0,
          sharePct: 100,
          apiCalls: 10,
          editTurns: 2,
          oneShotRatePct: 50,
          retriesPerEdit: 1,
          costPerEditUsd: 2.5,
        },
      ],
    });

    let view = await loadLedgerView(userId, "UTC", { from: "2026-08-01", to: "2026-08-31" });
    expect(view.sessions).toHaveLength(1);
    expect(view.tools[0].name).toBe("Bash");
    expect(view.modelQuality[0].oneShotRatePct).toBe(50);

    // 只带 days 的一轮（0.4.x 采集器就是这样）不该把快照清空
    await ingestLedger(userId, { days: [row()] });
    view = await loadLedgerView(userId, "UTC", { from: "2026-08-01", to: "2026-08-31" });
    expect(view.sessions).toHaveLength(1);
    expect(view.tools).toHaveLength(1);

    await db.user.delete({ where: { id: userId } });
  });
});
