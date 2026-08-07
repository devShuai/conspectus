import { describe, expect, it } from "vitest";

import { db } from "@/server/db";

const DISABLED = !process.env.TEST_DATABASE_URL;

function uniqueSub(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function setupUser() {
  return db.user.create({
    data: {
      certusSub: uniqueSub("m2"),
      certusLinkStatus: "active",
      lastStatusSyncedAt: new Date(),
    },
  });
}

async function setupSubscription(userId: string) {
  return db.subscription.create({
    data: {
      userId,
      name: "Test",
      price: 100,
      currency: "CNY",
      billingCycle: "monthly",
      startedAt: new Date("2026-01-01T00:00:00Z"),
      status: "active",
    },
  });
}

describe.skipIf(DISABLED)("m2 billing constraints", () => {
  it("rejects cross-user refund references and refund→refund", async () => {
    const a = await setupUser();
    const b = await setupUser();
    const subA = await setupSubscription(a.id);
    const subB = await setupSubscription(b.id);

    const chargeA = await db.billingRecord.create({
      data: {
        userId: a.id,
        subscriptionId: subA.id,
        amount: 100,
        currency: "CNY",
        recordType: "charge",
        billedAt: new Date("2026-01-01T00:00:00Z"),
        status: "paid",
        source: "manual",
      },
    });

    // cross-user refund
    await expect(
      db.billingRecord.create({
        data: {
          userId: b.id,
          subscriptionId: subB.id,
          amount: 10,
          currency: "CNY",
          recordType: "refund",
          originalRecordId: chargeA.id,
          billedAt: new Date("2026-01-02T00:00:00Z"),
          status: "paid",
          source: "manual",
        },
      }),
    ).rejects.toThrow(/refund must match user/);

    // charge must not reference original
    await expect(
      db.billingRecord.create({
        data: {
          userId: a.id,
          subscriptionId: subA.id,
          amount: 50,
          currency: "CNY",
          recordType: "charge",
          originalRecordId: chargeA.id,
          billedAt: new Date("2026-01-02T00:00:00Z"),
          status: "paid",
          source: "manual",
        },
      }),
    ).rejects.toThrow(/charge must not reference/);

    // refund→refund
    const refundA = await db.billingRecord.create({
      data: {
        userId: a.id,
        subscriptionId: subA.id,
        amount: 10,
        currency: "CNY",
        recordType: "refund",
        originalRecordId: chargeA.id,
        billedAt: new Date("2026-01-02T00:00:00Z"),
        status: "paid",
        source: "manual",
      },
    });
    await expect(
      db.billingRecord.create({
        data: {
          userId: a.id,
          subscriptionId: subA.id,
          amount: 5,
          currency: "CNY",
          recordType: "refund",
          originalRecordId: refundA.id,
          billedAt: new Date("2026-01-03T00:00:00Z"),
          status: "paid",
          source: "manual",
        },
      }),
    ).rejects.toThrow(/must reference a paid charge/);

    await db.billingRecord.deleteMany({ where: { userId: { in: [a.id, b.id] } } });
    await db.subscription.deleteMany({ where: { userId: { in: [a.id, b.id] } } });
    await db.user.deleteMany({ where: { id: { in: [a.id, b.id] } } });
  });

  it("rejects refunds exceeding the original amount", async () => {
    const user = await setupUser();
    const sub = await setupSubscription(user.id);
    const charge = await db.billingRecord.create({
      data: {
        userId: user.id,
        subscriptionId: sub.id,
        amount: 50,
        currency: "CNY",
        recordType: "charge",
        billedAt: new Date("2026-01-01T00:00:00Z"),
        status: "paid",
        source: "manual",
      },
    });

    await expect(
      db.billingRecord.create({
        data: {
          userId: user.id,
          subscriptionId: sub.id,
          amount: 60,
          currency: "CNY",
          recordType: "refund",
          originalRecordId: charge.id,
          billedAt: new Date("2026-01-02T00:00:00Z"),
          status: "paid",
          source: "manual",
        },
      }),
    ).rejects.toThrow(/exceeds original/);

    await db.billingRecord.deleteMany({ where: { userId: user.id } });
    await db.subscription.deleteMany({ where: { userId: user.id } });
    await db.user.delete({ where: { id: user.id } });
  });

  it("only paid records can receive a conversion projection", async () => {
    const user = await setupUser();
    const sub = await setupSubscription(user.id);
    const pending = await db.billingRecord.create({
      data: {
        userId: user.id,
        subscriptionId: sub.id,
        amount: 100,
        currency: "USD",
        recordType: "charge",
        billedAt: new Date("2026-01-01T00:00:00Z"),
        status: "pending",
        source: "system",
      },
    });

    await expect(
      db.billingConversion.create({
        data: {
          userId: user.id,
          billingRecordId: pending.id,
          baseCurrency: "CNY",
          signedAmountInBase: 720,
          fxRate: 7.2,
          fxDate: new Date("2026-01-01T00:00:00Z"),
        },
      }),
    ).rejects.toThrow(/only allowed for paid/);

    await db.billingRecord.deleteMany({ where: { userId: user.id } });
    await db.subscription.deleteMany({ where: { userId: user.id } });
    await db.user.delete({ where: { id: user.id } });
  });

  it("occurrenceKey and (userId,externalRef) are idempotent", async () => {
    const user = await setupUser();
    const sub = await setupSubscription(user.id);
    const base = {
      userId: user.id,
      subscriptionId: sub.id,
      amount: 100,
      currency: "CNY",
      recordType: "charge" as const,
      billedAt: new Date("2026-01-01T00:00:00Z"),
      status: "paid" as const,
      source: "system" as const,
    };

    await db.billingRecord.create({ data: { ...base, occurrenceKey: "occ:1" } });
    await expect(
      db.billingRecord.create({ data: { ...base, occurrenceKey: "occ:1" } }),
    ).rejects.toThrow();

    await db.billingRecord.create({ data: { ...base, externalRef: "ext:1" } });
    await expect(
      db.billingRecord.create({ data: { ...base, externalRef: "ext:1" } }),
    ).rejects.toThrow();

    await db.billingRecord.deleteMany({ where: { userId: user.id } });
    await db.subscription.deleteMany({ where: { userId: user.id } });
    await db.user.delete({ where: { id: user.id } });
  });

  it("enforces one active rebase job per user", async () => {
    const user = await setupUser();
    await db.currencyRebaseJob.create({
      data: {
        userId: user.id,
        fromCurrency: "USD",
        toCurrency: "CNY",
        status: "running",
      },
    });
    await expect(
      db.currencyRebaseJob.create({
        data: {
          userId: user.id,
          fromCurrency: "USD",
          toCurrency: "CNY",
          status: "pending",
        },
      }),
    ).rejects.toThrow();
    await db.currencyRebaseJob.deleteMany({ where: { userId: user.id } });
    await db.user.delete({ where: { id: user.id } });
  });
});
