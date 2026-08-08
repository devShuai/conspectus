import { describe, expect, it } from "vitest";

import { db } from "@/server/db";
import { billingCalendar, categoryBreakdown, dashboardStats, monthlyTrend } from "./stats";

const DISABLED = !process.env.TEST_DATABASE_URL;

function uniqueSub(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function setupUser() {
  return db.user.create({
    data: {
      certusSub: uniqueSub("stats"),
      certusLinkStatus: "active",
      lastStatusSyncedAt: new Date(),
      baseCurrency: "CNY",
    },
  });
}

describe.skipIf(DISABLED)("dashboard stats", () => {
  it("computes month net spend with refunds as negative in refund month", async () => {
    const user = await setupUser();
    const sub = await db.subscription.create({
      data: {
        userId: user.id,
        name: "T",
        price: 100,
        currency: "CNY",
        billingCycle: "monthly",
        startedAt: new Date("2026-01-01T00:00:00Z"),
        status: "active",
      },
    });
    const now = new Date();
    const charge = await db.billingRecord.create({
      data: {
        userId: user.id,
        subscriptionId: sub.id,
        amount: 100,
        currency: "CNY",
        recordType: "charge",
        billedAt: now,
        status: "paid",
        source: "manual",
      },
    });
    await db.billingConversion.create({
      data: {
        userId: user.id,
        billingRecordId: charge.id,
        baseCurrency: "CNY",
        signedAmountInBase: 100,
        fxRate: 1,
        fxDate: now,
      },
    });
    const refund = await db.billingRecord.create({
      data: {
        userId: user.id,
        subscriptionId: sub.id,
        amount: 30,
        currency: "CNY",
        recordType: "refund",
        originalRecordId: charge.id,
        billedAt: now,
        status: "paid",
        source: "manual",
      },
    });
    await db.billingConversion.create({
      data: {
        userId: user.id,
        billingRecordId: refund.id,
        baseCurrency: "CNY",
        signedAmountInBase: -30,
        fxRate: 1,
        fxDate: now,
      },
    });

    const stats = await dashboardStats(user.id);
    expect(stats.monthNetSpend).toBe(70);
    expect(stats.monthRefunds).toBe(30);
    expect(stats.monthCharges).toBe(100);
    expect(stats.activeCount).toBe(1);
    expect(stats.annualized).toBe(1200);

    await db.billingConversion.deleteMany({ where: { userId: user.id } });
    await db.billingRecord.deleteMany({ where: { userId: user.id } });
    await db.subscription.deleteMany({ where: { userId: user.id } });
    await db.user.delete({ where: { id: user.id } });
  });

  it("flags incomplete when paid records lack projections (never zero)", async () => {
    const user = await setupUser();
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
    await db.billingRecord.create({
      data: {
        userId: user.id,
        subscriptionId: sub.id,
        amount: 10,
        currency: "USD",
        recordType: "charge",
        billedAt: new Date(),
        status: "paid",
        source: "manual",
      },
    });

    const stats = await dashboardStats(user.id);
    expect(stats.incomplete).toBe(true);
    expect(stats.missingProjections).toBe(1);
    expect(stats.monthNetSpend).toBe(0); // nothing silently added

    await db.billingRecord.deleteMany({ where: { userId: user.id } });
    await db.subscription.deleteMany({ where: { userId: user.id } });
    await db.user.delete({ where: { id: user.id } });
  });

  it("calendar lists due subscriptions and pending bills by date", async () => {
    const user = await setupUser();
    await db.subscription.create({
      data: {
        userId: user.id,
        name: "Netflix",
        price: 138,
        currency: "CNY",
        billingCycle: "monthly",
        startedAt: new Date("2026-01-01T00:00:00Z"),
        nextBillingAt: new Date("2026-02-15T00:00:00Z"),
        status: "active",
      },
    });
    const sub2 = await db.subscription.create({
      data: {
        userId: user.id,
        name: "Claude",
        price: 20,
        currency: "USD",
        billingCycle: "monthly",
        startedAt: new Date("2026-01-01T00:00:00Z"),
        status: "active",
      },
    });
    await db.billingRecord.create({
      data: {
        userId: user.id,
        subscriptionId: sub2.id,
        amount: 20,
        currency: "USD",
        recordType: "charge",
        billedAt: new Date("2026-02-20T00:00:00Z"),
        status: "pending",
        source: "system",
      },
    });

    const days = await billingCalendar(user.id, 2026, 2);
    expect(days.length).toBe(2);
    expect(days[0]?.date).toBe("2026-02-15");
    expect(days[0]?.dueSubscriptions[0]?.name).toBe("Netflix");
    expect(days[1]?.date).toBe("2026-02-20");

    await db.billingRecord.deleteMany({ where: { userId: user.id } });
    await db.subscription.deleteMany({ where: { userId: user.id } });
    await db.user.delete({ where: { id: user.id } });
  });

  it("monthly trend splits paid and estimated-pending series (#72)", async () => {
    const user = await setupUser();
    const sub = await db.subscription.create({
      data: {
        userId: user.id,
        name: "T",
        price: 100,
        currency: "CNY",
        billingCycle: "monthly",
        startedAt: new Date("2026-01-01T00:00:00Z"),
        status: "active",
      },
    });
    const now = new Date();
    const twoMonthsAgo = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 10));

    const chargeNow = await db.billingRecord.create({
      data: {
        userId: user.id,
        subscriptionId: sub.id,
        amount: 100,
        currency: "CNY",
        recordType: "charge",
        billedAt: now,
        status: "paid",
        source: "manual",
      },
    });
    await db.billingConversion.create({
      data: {
        userId: user.id,
        billingRecordId: chargeNow.id,
        baseCurrency: "CNY",
        signedAmountInBase: 100,
        fxRate: 1,
        fxDate: now,
      },
    });
    const chargeOld = await db.billingRecord.create({
      data: {
        userId: user.id,
        subscriptionId: sub.id,
        amount: 50,
        currency: "CNY",
        recordType: "charge",
        billedAt: twoMonthsAgo,
        status: "paid",
        source: "manual",
      },
    });
    await db.billingConversion.create({
      data: {
        userId: user.id,
        billingRecordId: chargeOld.id,
        baseCurrency: "CNY",
        signedAmountInBase: 50,
        fxRate: 1,
        fxDate: twoMonthsAgo,
      },
    });
    // pending：USD 有最新汇率（估算），JPY 无汇率（不静默当 0）
    await db.billingRecord.create({
      data: {
        userId: user.id,
        subscriptionId: sub.id,
        amount: 10,
        currency: "USD",
        recordType: "charge",
        billedAt: now,
        status: "pending",
        source: "system",
      },
    });
    await db.billingRecord.create({
      data: {
        userId: user.id,
        subscriptionId: sub.id,
        amount: 500,
        currency: "JPY",
        recordType: "charge",
        billedAt: now,
        status: "pending",
        source: "system",
      },
    });
    await db.exchangeRate.upsert({
      where: { date_base_quote: { date: now, base: "USD", quote: "CNY" } },
      create: { date: now, base: "USD", quote: "CNY", rate: 7.2 },
      update: { rate: 7.2 },
    });

    const trend = await monthlyTrend(user.id);
    expect(trend.length).toBe(12);
    const currentKey = now.toISOString().slice(0, 7);
    const oldKey = twoMonthsAgo.toISOString().slice(0, 7);
    const current = trend.find((m) => m.month === currentKey);
    const old = trend.find((m) => m.month === oldKey);
    expect(trend[11]?.month).toBe(currentKey);
    expect(current?.paid).toBe(100);
    expect(current?.pending).toBeCloseTo(72, 6);
    expect(current?.pendingUncovered).toBe(true); // JPY 无汇率，标记而非当 0
    expect(old?.paid).toBe(50);

    await db.exchangeRate.deleteMany({ where: { base: "USD", quote: "CNY" } });
    await db.billingConversion.deleteMany({ where: { userId: user.id } });
    await db.billingRecord.deleteMany({ where: { userId: user.id } });
    await db.subscription.deleteMany({ where: { userId: user.id } });
    await db.user.delete({ where: { id: user.id } });
  });

  it("category breakdown sums annualized cost by vendor category (#72)", async () => {
    const user = await setupUser();
    const vendor = await db.vendor.create({
      data: { slug: uniqueSub("netflix"), name: "Netflix", category: "streaming" },
    });
    await db.subscription.create({
      data: {
        userId: user.id,
        vendorId: vendor.id,
        name: "Netflix",
        price: 100,
        currency: "CNY",
        billingCycle: "monthly",
        startedAt: new Date("2026-01-01T00:00:00Z"),
        status: "active",
      },
    });
    await db.subscription.create({
      data: {
        userId: user.id,
        name: "Claude",
        price: 20,
        currency: "USD",
        billingCycle: "monthly",
        startedAt: new Date("2026-01-01T00:00:00Z"),
        status: "active",
      },
    });
    await db.subscription.create({
      data: {
        userId: user.id,
        vendorId: vendor.id,
        name: "Paused",
        price: 999,
        currency: "CNY",
        billingCycle: "monthly",
        startedAt: new Date("2026-01-01T00:00:00Z"),
        status: "paused",
      },
    });
    const rateDate = new Date();
    await db.exchangeRate.upsert({
      where: { date_base_quote: { date: rateDate, base: "USD", quote: "CNY" } },
      create: { date: rateDate, base: "USD", quote: "CNY", rate: 7.2 },
      update: { rate: 7.2 },
    });

    const { slices, uncovered } = await categoryBreakdown(user.id);
    expect(uncovered).toBe(false);
    expect(slices.length).toBe(2);
    // uncategorized（240 USD×7.2=1728）> streaming（1200）；paused 不计入
    expect(slices[0]).toEqual({ category: "uncategorized", annualized: 1728 });
    expect(slices[1]).toEqual({ category: "streaming", annualized: 1200 });

    await db.exchangeRate.deleteMany({ where: { base: "USD", quote: "CNY" } });
    await db.subscription.deleteMany({ where: { userId: user.id } });
    await db.vendor.deleteMany({ where: { id: vendor.id } });
    await db.user.delete({ where: { id: user.id } });
  });

  it("annualized converts to base currency; pending is estimated with the latest rate (#105)", async () => {
    const user = await setupUser();
    await db.subscription.create({
      data: {
        userId: user.id,
        name: "USD Sub",
        price: 10,
        currency: "USD",
        billingCycle: "monthly",
        startedAt: new Date("2026-01-01T00:00:00Z"),
        status: "active",
      },
    });
    const sub2 = await db.subscription.create({
      data: {
        userId: user.id,
        name: "OneTime",
        price: 999,
        currency: "CNY",
        billingCycle: "one_time",
        startedAt: new Date("2026-01-01T00:00:00Z"),
        status: "active",
      },
    });
    await db.billingRecord.create({
      data: {
        userId: user.id,
        subscriptionId: sub2.id,
        amount: 10,
        currency: "USD",
        recordType: "charge",
        billedAt: new Date(),
        status: "pending",
        source: "system",
      },
    });
    const rateDate = new Date();
    await db.exchangeRate.upsert({
      where: { date_base_quote: { date: rateDate, base: "USD", quote: "CNY" } },
      create: { date: rateDate, base: "USD", quote: "CNY", rate: 7.2 },
      update: { rate: 7.2 },
    });

    const stats = await dashboardStats(user.id);
    // 年化：10 USD×12×7.2=864；one_time 不计入年化（§7.2 无口径，#105）
    expect(stats.annualized).toBe(864);
    expect(stats.annualizedUncovered).toBe(false);
    // pending：10 USD×7.2=72（此前恒 0，因为 pending 不投影）
    expect(stats.pendingEstimate).toBeCloseTo(72, 6);
    expect(stats.pendingUncovered).toBe(false);

    await db.exchangeRate.deleteMany({ where: { base: "USD", quote: "CNY" } });

    // 无汇率：标记 uncovered，绝不静默当 0
    const statsNoRate = await dashboardStats(user.id);
    expect(statsNoRate.annualizedUncovered).toBe(true);
    expect(statsNoRate.annualized).toBe(0);
    expect(statsNoRate.pendingUncovered).toBe(true);
    expect(statsNoRate.pendingEstimate).toBe(0);

    await db.billingRecord.deleteMany({ where: { userId: user.id } });
    await db.subscription.deleteMany({ where: { userId: user.id } });
    await db.user.delete({ where: { id: user.id } });
  });
});
