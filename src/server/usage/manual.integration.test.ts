import { describe, expect, it } from "vitest";

import { db } from "@/server/db";
import { createManualQuota, closeQuotaCycle, idleCandidates } from "./manual";
import { runPurge } from "@/server/auth/purge";

const DISABLED = !process.env.TEST_DATABASE_URL;

function uniqueSub(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function setupUser() {
  return db.user.create({
    data: {
      certusSub: uniqueSub("manual"),
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

describe.skipIf(DISABLED)("manual usage + cycle close + idle", () => {
  it("creates quota with server-generated manual binding", async () => {
    const user = await setupUser();
    const sub = await setupSubscription(user.id);
    const { quotaId } = await createManualQuota({
      userId: user.id,
      subscriptionId: sub.id,
      kind: "quota",
      metric: "requests",
      unit: "req",
      limitValue: 100,
      usedValue: 0,
      resetCycle: "daily",
      periodStart: new Date("2026-01-01T00:00:00Z"),
      periodEnd: new Date("2026-01-02T00:00:00Z"),
    });
    const quota = await db.usageQuota.findUnique({ where: { id: quotaId } });
    expect(quota?.authoritativeBindingId).not.toBeNull();
    const binding = await db.usageBinding.findUnique({
      where: { id: quota?.authoritativeBindingId ?? "" },
    });
    expect(binding?.source).toBe("manual");
    expect(binding?.sourceKey).toBe("form");

    await db.usageSnapshot.deleteMany({ where: { userId: user.id } });
    await db.usageBinding.deleteMany({ where: { userId: user.id } });
    await db.usageQuota.deleteMany({ where: { userId: user.id } });
    await db.subscription.deleteMany({ where: { id: sub.id } });
    await db.user.delete({ where: { id: user.id } });
  });

  it("closes cycle into summary with fixed utilization, then resets", async () => {
    const user = await setupUser();
    const sub = await setupSubscription(user.id);
    const { quotaId } = await createManualQuota({
      userId: user.id,
      subscriptionId: sub.id,
      kind: "quota",
      metric: "requests",
      unit: "req",
      limitValue: 100,
      usedValue: 40,
      resetCycle: "daily",
      periodStart: new Date("2026-01-01T00:00:00Z"),
      periodEnd: new Date("2026-01-02T00:00:00Z"),
    });

    // change limit AFTER close must not affect historical summary
    await closeQuotaCycle(user.id, quotaId, new Date("2026-01-02T00:00:00Z"));
    await db.usageQuota.update({ where: { id: quotaId }, data: { limitValue: 500 } });

    const summary = await db.usageCycleSummary.findFirst({
      where: { quotaId },
    });
    expect(Number(summary?.utilizationAtClose)).toBeCloseTo(0.4, 5);
    expect(Number(summary?.limitValueAtClose)).toBe(100);
    const quota = await db.usageQuota.findUnique({ where: { id: quotaId } });
    expect(Number(quota?.usedValue)).toBe(0);

    await db.usageCycleSummary.deleteMany({ where: { userId: user.id } });
    await db.usageSnapshot.deleteMany({ where: { userId: user.id } });
    await db.usageBinding.deleteMany({ where: { userId: user.id } });
    await db.usageQuota.deleteMany({ where: { userId: user.id } });
    await db.subscription.deleteMany({ where: { id: sub.id } });
    await db.user.delete({ where: { id: user.id } });
  });

  it("detects idle quotas from fixed summaries", async () => {
    const user = await setupUser();
    const sub = await setupSubscription(user.id);
    const { quotaId } = await createManualQuota({
      userId: user.id,
      subscriptionId: sub.id,
      kind: "quota",
      metric: "requests",
      unit: "req",
      limitValue: 100,
      usedValue: 2,
      resetCycle: "monthly",
      periodStart: new Date("2026-01-01T00:00:00Z"),
      periodEnd: new Date("2026-02-01T00:00:00Z"),
    });
    // simulate 3 closed idle cycles
    for (let m = 0; m < 3; m++) {
      await db.usageCycleSummary.create({
        data: {
          userId: user.id,
          quotaId,
          periodStart: new Date(`2026-0${m + 1}-01T00:00:00Z`),
          periodEnd: new Date(`2026-0${m + 2}-01T00:00:00Z`),
          finalValue: 1,
          limitValueAtClose: 100,
          utilizationAtClose: 0.01,
          unitAtClose: "req",
        },
      });
    }
    const idle = await idleCandidates(user.id);
    expect(idle.some((i) => i.quotaId === quotaId)).toBe(true);

    await db.usageCycleSummary.deleteMany({ where: { userId: user.id } });
    await db.usageSnapshot.deleteMany({ where: { userId: user.id } });
    await db.usageBinding.deleteMany({ where: { userId: user.id } });
    await db.usageQuota.deleteMany({ where: { userId: user.id } });
    await db.subscription.deleteMany({ where: { id: sub.id } });
    await db.user.delete({ where: { id: user.id } });
  });

  it("purge keeps referenced current snapshots and clears raw after 30d", async () => {
    const user = await setupUser();
    const sub = await setupSubscription(user.id);
    const { quotaId } = await createManualQuota({
      userId: user.id,
      subscriptionId: sub.id,
      kind: "counter",
      metric: "tokens",
      unit: "tok",
      usedValue: 5,
      resetCycle: "never",
    });
    const oldSnapshot = await db.usageSnapshot.create({
      data: {
        userId: user.id,
        quotaId,
        bindingId: (await db.usageBinding.findFirst({ where: { quotaId } }))!.id,
        capturedAt: new Date(Date.now() - 200 * 86_400_000),
        kindAtCapture: "counter",
        unitAtCapture: "tok",
        value: 5,
        raw: "debug-payload",
        createdAt: new Date(Date.now() - 40 * 86_400_000),
      },
    });
    await db.usageQuota.update({
      where: { id: quotaId },
      data: { valueSnapshotId: oldSnapshot.id, valueCapturedAt: oldSnapshot.capturedAt },
    });

    await runPurge();
    // referenced snapshot survives (raw cleared though)
    const kept = await db.usageSnapshot.findUnique({ where: { id: oldSnapshot.id } });
    expect(kept).not.toBeNull();
    expect(kept?.raw).toBeNull();

    await db.usageSnapshot.deleteMany({ where: { userId: user.id } });
    await db.usageBinding.deleteMany({ where: { userId: user.id } });
    await db.usageQuota.deleteMany({ where: { userId: user.id } });
    await db.subscription.deleteMany({ where: { id: sub.id } });
    await db.user.delete({ where: { id: user.id } });
  });
});
