import { describe, expect, it } from "vitest";

import { db } from "@/server/db";
import { billingCalendar, dashboardStats } from "./stats.js";

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
});
