import { describe, expect, it, vi } from "vitest";

import { db } from "@/server/db";
import {
  BillingError,
  confirmPendingCharge,
  recordPaidCharge,
  recordRefund,
} from "./billing";

const DISABLED = !process.env.TEST_DATABASE_URL;

function uniqueSub(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function setupUser(baseCurrency = "CNY") {
  return db.user.create({
    data: {
      certusSub: uniqueSub("bill"),
      certusLinkStatus: "active",
      lastStatusSyncedAt: new Date(),
      baseCurrency,
    },
  });
}

async function setupSubscription(userId: string, currency = "CNY") {
  return db.subscription.create({
    data: {
      userId,
      name: "Test",
      price: 100,
      currency,
      billingCycle: "monthly",
      startedAt: new Date("2026-01-01T00:00:00Z"),
      status: "active",
    },
  });
}

describe.skipIf(DISABLED)("billing service", () => {
  it("records a paid charge with base-currency projection (fx=1)", async () => {
    const user = await setupUser();
    const sub = await setupSubscription(user.id, "CNY");
    const result = await recordPaidCharge({
      userId: user.id,
      subscriptionId: sub.id,
      amount: 138,
      currency: "CNY",
      billedAt: new Date("2026-01-15T00:00:00Z"),
      source: "manual",
    });
    expect(result.projected).toBe(true);
    const conversion = await db.billingConversion.findFirst({
      where: { billingRecordId: result.billingRecordId },
    });
    expect(Number(conversion?.signedAmountInBase)).toBe(138);
    expect(Number(conversion?.fxRate)).toBe(1);

    await db.billingConversion.deleteMany({ where: { userId: user.id } });
    await db.billingRecord.deleteMany({ where: { userId: user.id } });
    await db.subscription.deleteMany({ where: { userId: user.id } });
    await db.user.delete({ where: { id: user.id } });
  });

  it("partial refund records in refund month without touching the original", async () => {
    const user = await setupUser();
    const sub = await setupSubscription(user.id, "CNY");
    const charge = await recordPaidCharge({
      userId: user.id,
      subscriptionId: sub.id,
      amount: 100,
      currency: "CNY",
      billedAt: new Date("2026-01-15T00:00:00Z"),
      source: "manual",
    });

    const refund = await recordRefund({
      userId: user.id,
      subscriptionId: sub.id,
      originalRecordId: charge.billingRecordId,
      amount: 30,
      currency: "CNY",
      billedAt: new Date("2026-02-10T00:00:00Z"),
      source: "manual",
    });

    const original = await db.billingRecord.findUnique({
      where: { id: charge.billingRecordId },
    });
    expect(Number(original?.amount)).toBe(100); // immutable

    const refundRow = await db.billingRecord.findUnique({
      where: { id: refund.billingRecordId },
    });
    expect(refundRow?.billedAt).toEqual(new Date("2026-02-10T00:00:00Z"));
    expect(Number(refundRow?.amount)).toBe(30);
    const refundConversion = await db.billingConversion.findFirst({
      where: { billingRecordId: refund.billingRecordId },
    });
    expect(Number(refundConversion?.signedAmountInBase)).toBe(-30);

    await db.billingConversion.deleteMany({ where: { userId: user.id } });
    await db.billingRecord.deleteMany({ where: { userId: user.id } });
    await db.subscription.deleteMany({ where: { userId: user.id } });
    await db.user.delete({ where: { id: user.id } });
  });

  it("concurrent refunds never exceed the original amount", async () => {
    const user = await setupUser();
    const sub = await setupSubscription(user.id, "CNY");
    const charge = await recordPaidCharge({
      userId: user.id,
      subscriptionId: sub.id,
      amount: 100,
      currency: "CNY",
      billedAt: new Date("2026-01-15T00:00:00Z"),
      source: "manual",
    });

    // Two refunds of 60 + 60 must fail at least once (sum > 100).
    const results = await Promise.allSettled([
      recordRefund({
        userId: user.id,
        subscriptionId: sub.id,
        originalRecordId: charge.billingRecordId,
        amount: 60,
        currency: "CNY",
        billedAt: new Date("2026-02-01T00:00:00Z"),
        source: "manual",
      }),
      recordRefund({
        userId: user.id,
        subscriptionId: sub.id,
        originalRecordId: charge.billingRecordId,
        amount: 60,
        currency: "CNY",
        billedAt: new Date("2026-02-01T00:00:00Z"),
        source: "manual",
      }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled").length;
    expect(fulfilled).toBe(1);

    await db.billingConversion.deleteMany({ where: { userId: user.id } });
    await db.billingRecord.deleteMany({ where: { userId: user.id } });
    await db.subscription.deleteMany({ where: { userId: user.id } });
    await db.user.delete({ where: { id: user.id } });
  });

  it("stores without projection when fx missing (incomplete, not zero)", async () => {
    const user = await setupUser("SEK");
    const sub = await setupSubscription(user.id, "ZAR");
    // 事务外按需抓取也失败（无网络/上游 5xx）→ 账单照存、投影待补（§7.3）。
    // 币种对用冷门的 ZAR/SEK：共享测试库里绝不会有 ≤ billedAt 的既有行
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("no network")));
    let result;
    try {
      result = await recordPaidCharge({
        userId: user.id,
        subscriptionId: sub.id,
        amount: 10,
        currency: "ZAR",
        billedAt: new Date("2026-01-15T00:00:00Z"),
        source: "manual",
      });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(result.projected).toBe(false);
    const conversion = await db.billingConversion.findFirst({
      where: { billingRecordId: result.billingRecordId },
    });
    expect(conversion).toBeNull();

    await db.billingRecord.deleteMany({ where: { userId: user.id } });
    await db.subscription.deleteMany({ where: { userId: user.id } });
    await db.user.delete({ where: { id: user.id } });
  });

  it("fetches a historical fix on demand outside the tx when the table has no rate (#106)", async () => {
    const user = await setupUser("JPY");
    const sub = await setupSubscription(user.id, "KRW");
    const fxDate = new Date("2026-01-14T00:00:00Z");
    // frankfurter 区间响应：含 01-13/01-14 两个 fix，billedAt=01-15 无 fix
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          rates: { "2026-01-13": { JPY: 0.11 }, "2026-01-14": { JPY: 0.12 } },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    let result;
    try {
      result = await recordPaidCharge({
        userId: user.id,
        subscriptionId: sub.id,
        amount: 10000,
        currency: "KRW",
        billedAt: new Date("2026-01-15T00:00:00Z"),
        source: "manual",
      });
    } finally {
      vi.unstubAllGlobals();
    }

    expect(result.projected).toBe(true);
    expect(fetchMock).toHaveBeenCalled();
    // 抓到 ≤ billedAt 的最近 fix 并落表
    const saved = await db.exchangeRate.findUnique({
      where: { date_base_quote: { date: fxDate, base: "KRW", quote: "JPY" } },
    });
    expect(saved).not.toBeNull();
    expect(Number(saved?.rate)).toBeCloseTo(0.12, 8);
    const conversion = await db.billingConversion.findFirst({
      where: { billingRecordId: result.billingRecordId },
    });
    expect(Number(conversion?.fxRate)).toBeCloseTo(0.12, 8);
    expect(conversion?.fxDate).toEqual(fxDate);
    expect(conversion?.rateSource).toBe("provider");
    expect(Number(conversion?.signedAmountInBase)).toBeCloseTo(1200, 5);

    await db.billingConversion.deleteMany({ where: { userId: user.id } });
    await db.exchangeRate.delete({ where: { date_base_quote: { date: fxDate, base: "KRW", quote: "JPY" } } });
    await db.billingRecord.deleteMany({ where: { userId: user.id } });
    await db.subscription.deleteMany({ where: { userId: user.id } });
    await db.user.delete({ where: { id: user.id } });
  });

  it("marks a caller-provided fixed rate as manual rateSource (#106)", async () => {
    const user = await setupUser("CNY");
    const sub = await setupSubscription(user.id, "USD");
    const result = await recordPaidCharge({
      userId: user.id,
      subscriptionId: sub.id,
      amount: 10,
      currency: "USD",
      billedAt: new Date("2026-01-15T00:00:00Z"),
      source: "manual",
      fxRate: 7,
      fxDate: new Date("2026-01-15T00:00:00Z"),
    });
    expect(result.projected).toBe(true);
    const conversion = await db.billingConversion.findFirst({
      where: { billingRecordId: result.billingRecordId },
    });
    expect(conversion?.rateSource).toBe("manual");
    expect(Number(conversion?.fxRate)).toBe(7);
    expect(Number(conversion?.signedAmountInBase)).toBe(70);

    await db.billingConversion.deleteMany({ where: { userId: user.id } });
    await db.billingRecord.deleteMany({ where: { userId: user.id } });
    await db.subscription.deleteMany({ where: { userId: user.id } });
    await db.user.delete({ where: { id: user.id } });
  });

  it("rejects fx-uncovered currencies without a manual rate, accepts them with one (#106)", async () => {
    const user = await setupUser("CNY");
    const sub = await setupSubscription(user.id, "XXX");
    await expect(
      recordPaidCharge({
        userId: user.id,
        subscriptionId: sub.id,
        amount: 10,
        currency: "XXX",
        billedAt: new Date("2026-01-15T00:00:00Z"),
        source: "manual",
      }),
    ).rejects.toThrow(BillingError);

    const result = await recordPaidCharge({
      userId: user.id,
      subscriptionId: sub.id,
      amount: 10,
      currency: "XXX",
      billedAt: new Date("2026-01-15T00:00:00Z"),
      source: "manual",
      fxRate: 0.5,
    });
    expect(result.projected).toBe(true);
    const conversion = await db.billingConversion.findFirst({
      where: { billingRecordId: result.billingRecordId },
    });
    expect(conversion?.rateSource).toBe("manual");
    expect(Number(conversion?.signedAmountInBase)).toBe(5);

    await db.billingConversion.deleteMany({ where: { userId: user.id } });
    await db.billingRecord.deleteMany({ where: { userId: user.id } });
    await db.subscription.deleteMany({ where: { userId: user.id } });
    await db.user.delete({ where: { id: user.id } });
  });

  it("confirms pending charge into paid with projection", async () => {
    const user = await setupUser("CNY");
    const sub = await setupSubscription(user.id, "CNY");
    const pending = await db.billingRecord.create({
      data: {
        userId: user.id,
        subscriptionId: sub.id,
        amount: 50,
        currency: "CNY",
        recordType: "charge",
        billedAt: new Date("2026-01-15T00:00:00Z"),
        status: "pending",
        source: "system",
      },
    });
    const result = await confirmPendingCharge(user.id, pending.id, {});
    expect(result.projected).toBe(true);
    const record = await db.billingRecord.findUnique({
      where: { id: pending.id },
    });
    expect(record?.status).toBe("paid");

    await db.billingConversion.deleteMany({ where: { userId: user.id } });
    await db.billingRecord.deleteMany({ where: { userId: user.id } });
    await db.subscription.deleteMany({ where: { userId: user.id } });
    await db.user.delete({ where: { id: user.id } });
  });
});
