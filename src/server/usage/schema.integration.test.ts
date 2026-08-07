import { describe, expect, it } from "vitest";

import { db } from "@/server/db";

const DISABLED = !process.env.TEST_DATABASE_URL;

function uniqueSub(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function setupUser() {
  return db.user.create({
    data: {
      certusSub: uniqueSub("usage"),
      certusLinkStatus: "active",
      lastStatusSyncedAt: new Date(),
    },
  });
}

async function setupSubscription(userId: string) {
  return db.subscription.create({
    data: {
      userId,
      name: "T",
      price: 10,
      currency: "CNY",
      billingCycle: "monthly",
      startedAt: new Date("2026-01-01T00:00:00Z"),
      status: "active",
    },
  });
}

describe.skipIf(DISABLED)("m3 usage constraints", () => {
  it("rejects illegal kind field combinations", async () => {
    const user = await setupUser();
    const sub = await setupSubscription(user.id);

    await expect(
      db.usageQuota.create({
        data: {
          userId: user.id,
          subscriptionId: sub.id,
          kind: "balance",
          metric: "credit",
          unit: "CNY",
          remainingValue: 10,
          resetCycle: "monthly", // balance must be never
        },
      }),
    ).rejects.toThrow(/kind_fields/);

    await db.user.delete({ where: { id: user.id } });
  });

  it("rejects cross-tenant bindings", async () => {
    const a = await setupUser();
    const b = await setupUser();
    const sub = await setupSubscription(a.id);
    const quota = await db.usageQuota.create({
      data: {
        userId: a.id,
        subscriptionId: sub.id,
        kind: "quota",
        metric: "requests",
        unit: "req",
        limitValue: 100,
        usedValue: 10,
        periodStart: new Date(),
        periodEnd: new Date(Date.now() + 86_400_000),
        resetCycle: "daily",
      },
    });

    await expect(
      db.usageBinding.create({
        data: {
          userId: b.id,
          quotaId: quota.id,
          source: "manual",
          sourceKey: "form",
        },
      }),
    ).rejects.toThrow(/same user/);

    await db.user.delete({ where: { id: a.id } });
    await db.user.delete({ where: { id: b.id } });
  });

  it("snapshot idempotency on (binding, device, capturedAt)", async () => {
    const user = await setupUser();
    const sub = await setupSubscription(user.id);
    const quota = await db.usageQuota.create({
      data: {
        userId: user.id,
        subscriptionId: sub.id,
        kind: "counter",
        metric: "tokens",
        unit: "tok",
        usedValue: 100,
        resetCycle: "never",
      },
    });
    const binding = await db.usageBinding.create({
      data: {
        userId: user.id,
        quotaId: quota.id,
        source: "provider",
        sourceKey: "deepseek:tokens",
      },
    });
    const deviceId = "00000000-0000-0000-0000-0000000000aa";
    await db.usageSnapshot.create({
      data: {
        userId: user.id,
        quotaId: quota.id,
        bindingId: binding.id,
        capturedAt: new Date("2026-01-01T00:00:00Z"),
        kindAtCapture: "counter",
        unitAtCapture: "tok",
        value: 100,
        deviceId,
      },
    });
    await expect(
      db.usageSnapshot.create({
        data: {
          userId: user.id,
          quotaId: quota.id,
          bindingId: binding.id,
          capturedAt: new Date("2026-01-01T00:00:00Z"),
          kindAtCapture: "counter",
          unitAtCapture: "tok",
          value: 200,
          deviceId,
        },
      }),
    ).rejects.toThrow();

    await db.usageSnapshot.deleteMany({ where: { userId: user.id } });
    await db.usageBinding.deleteMany({ where: { userId: user.id } });
    await db.usageQuota.deleteMany({ where: { userId: user.id } });
    await db.subscription.deleteMany({ where: { userId: user.id } });
    await db.user.delete({ where: { id: user.id } });
  });
});
