import { describe, expect, it } from "vitest";

import { db } from "@/server/db";
import {
  backfillMissingProjections,
  collectFxPairs,
  countMissingProjections,
  markLatestFxStale,
  saveFxRate,
} from "./fx";

const DISABLED = !process.env.TEST_DATABASE_URL;

function uniqueSub(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function setupUser(baseCurrency: string) {
  return db.user.create({
    data: {
      certusSub: uniqueSub("fx"),
      certusLinkStatus: "active",
      lastStatusSyncedAt: new Date(),
      baseCurrency,
    },
  });
}

describe.skipIf(DISABLED)("fx backfill", () => {
  it("backfills projections and counts missing", async () => {
    const user = await setupUser("CNY");
    const sub = await db.subscription.create({
      data: {
        userId: user.id,
        name: "T",
        price: 10,
        currency: "USD",
        billingCycle: "monthly",
        startedAt: new Date("2026-01-01T00:00:00Z"),
        status: "active",
      },
    });
    const charge = await db.billingRecord.create({
      data: {
        userId: user.id,
        subscriptionId: sub.id,
        amount: 10,
        currency: "USD",
        recordType: "charge",
        billedAt: new Date("2026-01-10T00:00:00Z"),
        status: "paid",
        source: "manual",
      },
    });

    expect(await countMissingProjections(user.id, "CNY")).toBe(1);

    await db.exchangeRate.create({
      data: {
        date: new Date("2026-01-09T00:00:00Z"),
        base: "USD",
        quote: "CNY",
        rate: 7.2,
      },
    });
    const done = await backfillMissingProjections(user.id, "CNY");
    expect(done).toBe(1);
    expect(await countMissingProjections(user.id, "CNY")).toBe(0);

    const conversion = await db.billingConversion.findFirst({
      where: { billingRecordId: charge.id },
    });
    expect(Number(conversion?.signedAmountInBase)).toBeCloseTo(72, 5);

    await db.billingConversion.deleteMany({ where: { userId: user.id } });
    await db.exchangeRate.deleteMany({ where: { base: "USD", quote: "CNY" } });
    await db.billingRecord.deleteMany({ where: { userId: user.id } });
    await db.subscription.deleteMany({ where: { userId: user.id } });
    await db.user.delete({ where: { id: user.id } });
  });

  it("collects pairs for every user's base currency, not one global quote (#93)", async () => {
    const cnyUser = await setupUser("CNY");
    const usdUser = await setupUser("USD");
    const sub = await db.subscription.create({
      data: {
        userId: cnyUser.id,
        name: "T",
        price: 10,
        currency: "EUR",
        billingCycle: "monthly",
        startedAt: new Date("2026-01-01T00:00:00Z"),
        status: "active",
      },
    });

    const pairs = await collectFxPairs();
    const has = (base: string, quote: string) =>
      pairs.some((p) => p.base === base && p.quote === quote);

    // EUR 被使用 → 必须同时抓 EUR→CNY 与 EUR→USD（此前只有最早用户的 quote）
    expect(has("EUR", "CNY")).toBe(true);
    expect(has("EUR", "USD")).toBe(true);
    // 用户本位币互为使用时也成对
    expect(has("USD", "CNY")).toBe(true);
    expect(has("CNY", "USD")).toBe(true);
    // 不出现自己到自己的对
    expect(pairs.some((p) => p.base === p.quote)).toBe(false);

    await db.subscription.deleteMany({ where: { id: sub.id } });
    await db.user.delete({ where: { id: cnyUser.id } });
    await db.user.delete({ where: { id: usdUser.id } });
  });

  it("marks the last available rate stale on fallback and resets on a fresh fix (#106)", async () => {
    // 冷门币种对，避免撞共享测试库既有数据与其他文件的并发用例
    const d1 = new Date("2026-01-09T00:00:00Z");
    const d2 = new Date("2026-01-10T00:00:00Z");
    await saveFxRate(d1, "BRL", "SEK", 0.11);

    // 抓取失败 → 回退标记最近可用行
    expect(await markLatestFxStale("BRL", "SEK", d2)).toBe(true);
    const staled = await db.exchangeRate.findUnique({
      where: { date_base_quote: { date: d1, base: "BRL", quote: "SEK" } },
    });
    expect(staled?.stale).toBe(true);
    // 已 stale 的行重复标记 / 截止日前无可回退行 → false
    expect(await markLatestFxStale("BRL", "SEK", d2)).toBe(false);
    expect(await markLatestFxStale("BRL", "SEK", new Date("2026-01-01T00:00:00Z"))).toBe(false);

    // 新鲜 fix 落表后 stale 复位
    await saveFxRate(d2, "BRL", "SEK", 0.12);
    const fresh = await db.exchangeRate.findUnique({
      where: { date_base_quote: { date: d2, base: "BRL", quote: "SEK" } },
    });
    expect(fresh?.stale).toBe(false);

    await db.exchangeRate.deleteMany({
      where: { base: "BRL", quote: "SEK", date: { in: [d1, d2] } },
    });
  });
});
