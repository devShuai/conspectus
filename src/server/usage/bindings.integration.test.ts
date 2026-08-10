import { describe, expect, it } from "vitest";

import { db } from "@/server/db";

import {
  BindingError,
  createLocalBinding,
  createLocalCollectorSetup,
  deleteUsageMetric,
} from "./bindings";
import { createManualQuota } from "./manual";

const DISABLED = !process.env.TEST_DATABASE_URL;

function unique(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function makeUser(sub: string) {
  return db.user.create({
    data: { certusSub: sub, certusLinkStatus: "active", lastStatusSyncedAt: new Date() },
  });
}

describe.skipIf(DISABLED)("local collector bindings (#87)", () => {
  async function setup() {
    const user = await makeUser(unique("bind"));
    const sub = await db.subscription.create({
      data: {
        userId: user.id,
        name: "Claude Max",
        status: "active",
        price: 100,
        currency: "CNY",
        billingCycle: "yearly",
        startedAt: new Date("2026-01-01T00:00:00Z"),
      },
    });
    const { quotaId } = await createManualQuota({
      userId: user.id,
      subscriptionId: sub.id,
      kind: "quota",
      metric: "requests",
      unit: "%",
      limitValue: 100,
      usedValue: 0,
      resetCycle: "monthly",
      // 周期落在未来：cycle-reset runner 不会锁定本条（并发下曾有死锁）
      periodStart: new Date(Date.now() - 86_400_000),
      periodEnd: new Date(Date.now() + 86_400_000),
    });
    return { user, sub, quotaId };
  }

  it("creates a local binding and makes it authoritative when none exists", async () => {
    const { user, quotaId } = await setup();
    const { bindingId } = await createLocalBinding({
      userId: user.id,
      quotaId,
      collectorId: "claude-code",
      metric: "claude:five_hour",
    });

    const binding = await db.usageBinding.findUniqueOrThrow({ where: { id: bindingId } });
    expect(binding.source).toBe("local_agent");
    expect(binding.sourceKey).toBe("claude:five_hour");
    expect(binding.collectorId).toBe("claude-code");

    // 已有 manual binding 是首个权威，local 不抢
    const quota = await db.usageQuota.findUniqueOrThrow({ where: { id: quotaId } });
    const manualBinding = await db.usageBinding.findFirstOrThrow({
      where: { quotaId, source: "manual" },
    });
    expect(quota.authoritativeBindingId).toBe(manualBinding.id);

    // 同一 metric 重复绑定幂等复活，不另建行
    const again = await createLocalBinding({
      userId: user.id,
      quotaId,
      collectorId: "claude-code",
      metric: "claude:five_hour",
    });
    expect(again.bindingId).toBe(bindingId);

    await db.user.delete({ where: { id: user.id } });
  });

  it("sets authority when the quota has no authoritative binding yet", async () => {
    const { user, quotaId } = await setup();
    await db.usageQuota.update({
      where: { id: quotaId },
      data: { authoritativeBindingId: null },
    });
    const { bindingId } = await createLocalBinding({
      userId: user.id,
      quotaId,
      collectorId: "codex",
      metric: "codex:5h",
    });
    const quota = await db.usageQuota.findUniqueOrThrow({ where: { id: quotaId } });
    expect(quota.authoritativeBindingId).toBe(bindingId);

    await db.user.delete({ where: { id: user.id } });
  });

  it("validates collector and metric prefix", async () => {
    const { user, quotaId } = await setup();
    await expect(
      createLocalBinding({ userId: user.id, quotaId, collectorId: "unknown", metric: "x:y" }),
    ).rejects.toThrow(BindingError);
    await expect(
      createLocalBinding({
        userId: user.id,
        quotaId,
        collectorId: "codex",
        metric: "claude:tokens",
      }),
    ).rejects.toThrow(BindingError);

    await db.user.delete({ where: { id: user.id } });
  });

  it("refuses another user's quota", async () => {
    const { user, quotaId } = await setup();
    const other = await makeUser(unique("bind-other"));
    await expect(
      createLocalBinding({
        userId: other.id,
        quotaId,
        collectorId: "codex",
        metric: "codex:tokens",
      }),
    ).rejects.toThrow(BindingError);

    await db.user.delete({ where: { id: user.id } });
    await db.user.delete({ where: { id: other.id } });
  });

  it("creates catalog quotas with local authority and no manual binding", async () => {
    const user = await makeUser(unique("setup"));
    const sub = await db.subscription.create({
      data: {
        userId: user.id,
        name: "Kimi Coding Plan",
        status: "active",
        price: 99,
        currency: "CNY",
        billingCycle: "monthly",
        startedAt: new Date("2026-01-01T00:00:00Z"),
      },
    });

    const result = await createLocalCollectorSetup({
      userId: user.id,
      subscriptionId: sub.id,
      collectorId: "kimi-code",
      metrics: ["kimi:5h", "kimi:weekly"],
    });
    expect(result).toEqual({ created: 2, authorityNeedsConfirmation: 0 });

    const quotas = await db.usageQuota.findMany({
      where: { subscriptionId: sub.id },
      include: { bindings: true },
      orderBy: { metric: "asc" },
    });
    expect(quotas.map((quota) => quota.metric)).toEqual(["kimi:5h", "kimi:weekly"]);
    for (const quota of quotas) {
      expect(quota.bindings).toHaveLength(1);
      expect(quota.bindings[0].source).toBe("local_agent");
      expect(quota.authoritativeBindingId).toBe(quota.bindings[0].id);
    }

    await db.user.delete({ where: { id: user.id } });
  });

  it("deletes one metric and cascades its bindings, snapshots and cycle summaries", async () => {
    const { user, sub, quotaId } = await setup();
    const binding = await db.usageBinding.findFirstOrThrow({ where: { quotaId } });
    await db.usageSnapshot.create({
      data: {
        userId: user.id,
        quotaId,
        bindingId: binding.id,
        capturedAt: new Date("2026-08-01T00:00:00Z"),
        kindAtCapture: "quota",
        unitAtCapture: "%",
        value: 25,
        limitValueAtCapture: 100,
      },
    });
    await db.usageCycleSummary.create({
      data: {
        userId: user.id,
        quotaId,
        periodStart: new Date("2026-07-01T00:00:00Z"),
        periodEnd: new Date("2026-08-01T00:00:00Z"),
        finalValue: 25,
        limitValueAtClose: 100,
        utilizationAtClose: 0.25,
        unitAtClose: "%",
        authoritativeBindingIdAtClose: binding.id,
      },
    });
    const preserved = await createManualQuota({
      userId: user.id,
      subscriptionId: sub.id,
      kind: "counter",
      metric: "preserved",
      unit: "req",
      usedValue: 1,
      resetCycle: "never",
    });

    await deleteUsageMetric({ userId: user.id, quotaId });

    expect(await db.usageQuota.count({ where: { id: quotaId } })).toBe(0);
    expect(await db.usageBinding.count({ where: { quotaId } })).toBe(0);
    expect(await db.usageSnapshot.count({ where: { quotaId } })).toBe(0);
    expect(await db.usageCycleSummary.count({ where: { quotaId } })).toBe(0);
    expect(await db.usageQuota.count({ where: { id: preserved.quotaId } })).toBe(1);

    await db.user.delete({ where: { id: user.id } });
  });

  it("does not delete another user's metric", async () => {
    const { user, quotaId } = await setup();
    const other = await makeUser(unique("delete-other"));

    await expect(deleteUsageMetric({ userId: other.id, quotaId })).rejects.toMatchObject({
      reason: "quota_not_found",
    });
    expect(await db.usageQuota.count({ where: { id: quotaId } })).toBe(1);

    await db.user.delete({ where: { id: user.id } });
    await db.user.delete({ where: { id: other.id } });
  });
});
