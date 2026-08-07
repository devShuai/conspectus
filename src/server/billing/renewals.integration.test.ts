import { describe, expect, it } from "vitest";

import { db } from "@/server/db";
import { runRenewals } from "./renewals.js";

const DISABLED = !process.env.TEST_DATABASE_URL;

function uniqueSub(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function setupUser() {
  return db.user.create({
    data: {
      certusSub: uniqueSub("rn"),
      certusLinkStatus: "active",
      lastStatusSyncedAt: new Date(),
    },
  });
}

describe.skipIf(DISABLED)("renewals runner", () => {
  it("creates exactly one pending per due period (idempotent concurrency)", async () => {
    const user = await setupUser();
    const sub = await db.subscription.create({
      data: {
        userId: user.id,
        name: "T",
        price: 10,
        currency: "CNY",
        billingCycle: "monthly",
        startedAt: new Date("2025-12-01T00:00:00Z"),
        nextBillingAt: new Date("2026-01-01T00:00:00Z"),
        status: "active",
        autoRenew: true,
      },
    });

    const [a, b] = await Promise.all([
      runRenewals(new Date("2026-01-15T00:00:00Z")),
      runRenewals(new Date("2026-01-15T00:00:00Z")),
    ]);
    const pendings = await db.billingRecord.count({
      where: { subscriptionId: sub.id, status: "pending" },
    });
    expect(pendings).toBe(1);
    void a;
    void b;

    await db.billingRecord.deleteMany({ where: { subscriptionId: sub.id } });
    await db.subscription.deleteMany({ where: { userId: user.id } });
    await db.user.delete({ where: { id: user.id } });
  });

  it("autoRenew=false → expired with no pending bill", async () => {
    const user = await setupUser();
    const sub = await db.subscription.create({
      data: {
        userId: user.id,
        name: "T",
        price: 10,
        currency: "CNY",
        billingCycle: "monthly",
        startedAt: new Date("2025-12-01T00:00:00Z"),
        nextBillingAt: new Date("2026-01-01T00:00:00Z"),
        status: "active",
        autoRenew: false,
      },
    });

    await runRenewals(new Date("2026-01-15T00:00:00Z"));
    const updated = await db.subscription.findUnique({ where: { id: sub.id } });
    expect(updated?.status).toBe("expired");
    expect(updated?.nextBillingAt).toBeNull();
    expect(
      await db.billingRecord.count({ where: { subscriptionId: sub.id } }),
    ).toBe(0);

    await db.subscription.deleteMany({ where: { userId: user.id } });
    await db.user.delete({ where: { id: user.id } });
  });

  it("trial autoRenew=true → first pending at trialEndsAt then active", async () => {
    const user = await setupUser();
    const sub = await db.subscription.create({
      data: {
        userId: user.id,
        name: "Trial",
        price: 100,
        currency: "CNY",
        billingCycle: "monthly",
        startedAt: new Date("2025-12-01T00:00:00Z"),
        trialEndsAt: new Date("2026-01-10T00:00:00Z"),
        status: "trial",
        autoRenew: true,
      },
    });

    await runRenewals(new Date("2026-01-12T00:00:00Z"));
    const updated = await db.subscription.findUnique({ where: { id: sub.id } });
    expect(updated?.status).toBe("active");
    const pending = await db.billingRecord.findFirst({
      where: { subscriptionId: sub.id, status: "pending" },
    });
    expect(pending?.billedAt).toEqual(new Date("2026-01-10T00:00:00Z"));

    await db.billingRecord.deleteMany({ where: { subscriptionId: sub.id } });
    await db.subscription.deleteMany({ where: { userId: user.id } });
    await db.user.delete({ where: { id: user.id } });
  });

  it("trial autoRenew=false → expired with no bill", async () => {
    const user = await setupUser();
    const sub = await db.subscription.create({
      data: {
        userId: user.id,
        name: "Trial2",
        price: 100,
        currency: "CNY",
        billingCycle: "monthly",
        startedAt: new Date("2025-12-01T00:00:00Z"),
        trialEndsAt: new Date("2026-01-10T00:00:00Z"),
        status: "trial",
        autoRenew: false,
      },
    });

    await runRenewals(new Date("2026-01-12T00:00:00Z"));
    const updated = await db.subscription.findUnique({ where: { id: sub.id } });
    expect(updated?.status).toBe("expired");
    expect(
      await db.billingRecord.count({ where: { subscriptionId: sub.id } }),
    ).toBe(0);

    await db.subscription.deleteMany({ where: { userId: user.id } });
    await db.user.delete({ where: { id: user.id } });
  });
});
