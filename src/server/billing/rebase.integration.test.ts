import { describe, expect, it } from "vitest";

import { db } from "@/server/db";

import { RebaseError, requestBaseCurrencyChange } from "./rebase";

const DISABLED = !process.env.TEST_DATABASE_URL;

function unique(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function makeUser(sub: string) {
  return db.user.create({
    data: { certusSub: sub, certusLinkStatus: "active", lastStatusSyncedAt: new Date() },
  });
}

describe.skipIf(DISABLED)("requestBaseCurrencyChange (#71)", () => {
  it("rejects the same currency", async () => {
    const user = await makeUser(unique("rebase-1"));
    await expect(
      requestBaseCurrencyChange({ userId: user.id, toCurrency: "CNY" }),
    ).rejects.toThrow(RebaseError);
    await db.user.delete({ where: { id: user.id } });
  });

  it("switches immediately when no projection is missing", async () => {
    const user = await makeUser(unique("rebase-2"));
    const result = await requestBaseCurrencyChange({ userId: user.id, toCurrency: "USD" });
    expect(result.switched).toBe(true);

    const after = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.baseCurrency).toBe("USD");
    const job = await db.currencyRebaseJob.findFirstOrThrow({
      where: { userId: user.id },
    });
    expect(job.status).toBe("done");

    await db.user.delete({ where: { id: user.id } });
  });

  it("queues a job when projections are missing", async () => {
    const user = await makeUser(unique("rebase-3"));
    const sub = await db.subscription.create({
      data: {
        userId: user.id,
        name: "Netflix",
        status: "active",
        price: 138,
        currency: "CNY",
        billingCycle: "monthly",
        startedAt: new Date("2026-01-01T00:00:00Z"),
      },
    });
    await db.billingRecord.create({
      data: {
        userId: user.id,
        subscriptionId: sub.id,
        amount: 138,
        currency: "CNY",
        recordType: "charge",
        billedAt: new Date("2026-02-01T00:00:00Z"),
        status: "paid",
        source: "manual",
      },
    });

    const result = await requestBaseCurrencyChange({ userId: user.id, toCurrency: "USD" });
    expect(result.switched).toBe(false);
    expect(result.totalCount).toBe(1);

    const job = await db.currencyRebaseJob.findFirstOrThrow({
      where: { userId: user.id },
    });
    expect(job.status).toBe("pending");
    expect(job.totalCount).toBe(1);
    // 完成前不切换（design §7.3：查询永远只读到一套完整口径）
    const after = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.baseCurrency).toBe("CNY");

    await db.user.delete({ where: { id: user.id } });
  });

  it("rejects a second job while one is in flight", async () => {
    const user = await makeUser(unique("rebase-4"));
    await db.currencyRebaseJob.create({
      data: {
        userId: user.id,
        fromCurrency: "CNY",
        toCurrency: "EUR",
        status: "pending",
        totalCount: 1,
      },
    });
    await expect(
      requestBaseCurrencyChange({ userId: user.id, toCurrency: "USD" }),
    ).rejects.toThrow(RebaseError);
    await db.user.delete({ where: { id: user.id } });
  });
});
