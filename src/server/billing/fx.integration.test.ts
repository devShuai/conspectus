import { describe, expect, it } from "vitest";

import { db } from "@/server/db";
import { backfillMissingProjections, countMissingProjections } from "./fx";

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
});
