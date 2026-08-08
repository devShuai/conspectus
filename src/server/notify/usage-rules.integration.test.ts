import { describe, expect, it } from "vitest";

import { db } from "@/server/db";
import { updateSubscription } from "@/server/billing/subscriptions";
import { ingestReadings } from "@/server/usage/ingest";

import { runNotificationScan } from "./scan";
import {
  clearConnectionFailure,
  evaluateUsageRules,
  notifyConnectionFailed,
} from "./usage-rules";

const DISABLED = !process.env.TEST_DATABASE_URL;

function unique(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function setupUser() {
  return db.user.create({
    data: {
      certusSub: unique("n114"),
      certusLinkStatus: "active",
      lastStatusSyncedAt: new Date(),
      emailVerifiedAt: new Date(),
      emailVerificationSource: "local",
      email: `n114-${Date.now()}@example.com`,
    },
  });
}

async function setupSubscription(userId: string) {
  return db.subscription.create({
    data: {
      userId,
      name: "Plan",
      price: 100,
      currency: "CNY",
      billingCycle: "monthly",
      startedAt: new Date("2026-01-01T00:00:00Z"),
      status: "active",
    },
  });
}

async function eventsOf(userId: string, type?: string) {
  const events = await db.notificationEvent.findMany({
    where: { userId },
    include: { rule: { select: { type: true } } },
  });
  return type ? events.filter((e) => e.rule.type === type) : events;
}

describe.skipIf(DISABLED)("rule evaluation entries (#114)", () => {
  it("usage_threshold fires at threshold, dedupes in period, re-fires next period", async () => {
    const user = await setupUser();
    const sub = await setupSubscription(user.id);
    await db.notificationRule.create({
      data: { userId: user.id, type: "usage_threshold", config: { percent: [80, 95] } },
    });
    const quota = await db.usageQuota.create({
      data: {
        userId: user.id,
        subscriptionId: sub.id,
        kind: "quota",
        metric: "requests",
        unit: "req",
        limitValue: 100,
        usedValue: 85,
        resetCycle: "monthly",
        periodStart: new Date("2026-08-01T00:00:00Z"),
        periodEnd: new Date("2026-09-01T00:00:00Z"),
      },
    });

    // 85%：只触发 80 档
    await evaluateUsageRules(user.id, [quota.id]);
    expect((await eventsOf(user.id, "usage_threshold")).length).toBe(1);

    // 96%：补 95 档；同周期 80 档 dedupe 不重复
    await db.usageQuota.update({ where: { id: quota.id }, data: { usedValue: 96 } });
    await evaluateUsageRules(user.id, [quota.id]);
    expect((await eventsOf(user.id, "usage_threshold")).length).toBe(2);

    // 再求值一次：不新增
    await evaluateUsageRules(user.id, [quota.id]);
    expect((await eventsOf(user.id, "usage_threshold")).length).toBe(2);

    // 新周期（periodStart 换 key）：80/95 重新各报一次
    await db.usageQuota.update({
      where: { id: quota.id },
      data: { periodStart: new Date("2026-09-01T00:00:00Z"), usedValue: 97 },
    });
    await evaluateUsageRules(user.id, [quota.id]);
    expect((await eventsOf(user.id, "usage_threshold")).length).toBe(4);

    await db.user.delete({ where: { id: user.id } });
  });

  it("subscription-scoped rule only fires for its own subscription's quotas", async () => {
    const user = await setupUser();
    const sub = await setupSubscription(user.id);
    const otherSub = await setupSubscription(user.id);
    // 规则挂在别的订阅上：本 quota 不得触发
    await db.notificationRule.create({
      data: {
        userId: user.id,
        type: "usage_threshold",
        config: { percent: [80] },
        subscriptionId: otherSub.id,
      },
    });
    const quota = await db.usageQuota.create({
      data: {
        userId: user.id,
        subscriptionId: sub.id,
        kind: "quota",
        metric: "requests",
        unit: "req",
        limitValue: 100,
        usedValue: 90,
        resetCycle: "monthly",
        periodStart: new Date("2026-08-01T00:00:00Z"),
        periodEnd: new Date("2026-09-01T00:00:00Z"),
      },
    });

    await evaluateUsageRules(user.id, [quota.id]);
    expect((await eventsOf(user.id, "usage_threshold")).length).toBe(0);

    // 规则改挂本订阅：触发
    await db.notificationRule.updateMany({
      where: { userId: user.id },
      data: { subscriptionId: sub.id },
    });
    await evaluateUsageRules(user.id, [quota.id]);
    expect((await eventsOf(user.id, "usage_threshold")).length).toBe(1);

    await db.user.delete({ where: { id: user.id } });
  });

  it("balance_low arms once, clears with hysteresis, re-arms on next drop", async () => {
    const user = await setupUser();
    const sub = await setupSubscription(user.id);
    await db.notificationRule.create({
      data: { userId: user.id, type: "balance_low", config: { minValue: 10 } },
    });
    const quota = await db.usageQuota.create({
      data: {
        userId: user.id,
        subscriptionId: sub.id,
        kind: "balance",
        metric: "credit",
        unit: "CNY",
        remainingValue: 5,
        resetCycle: "never",
      },
    });

    await evaluateUsageRules(user.id, [quota.id]);
    expect((await eventsOf(user.id, "balance_low")).length).toBe(1);
    // 持续低位：不重复报
    await evaluateUsageRules(user.id, [quota.id]);
    expect((await eventsOf(user.id, "balance_low")).length).toBe(1);

    // 恢复到 10×1.1 以上 → clear
    await db.usageQuota.update({ where: { id: quota.id }, data: { remainingValue: 12 } });
    await evaluateUsageRules(user.id, [quota.id]);
    const arm = await db.notificationArmState.findFirst({ where: { userId: user.id } });
    expect(arm?.clearedAt).not.toBeNull();

    // 再跌破 → 重新武装并再报一次
    await db.usageQuota.update({ where: { id: quota.id }, data: { remainingValue: 3 } });
    await evaluateUsageRules(user.id, [quota.id]);
    expect((await eventsOf(user.id, "balance_low")).length).toBe(2);

    await db.user.delete({ where: { id: user.id } });
  });

  it("ingest entry: an over-threshold reading evaluates rules end to end", async () => {
    const user = await setupUser();
    const sub = await setupSubscription(user.id);
    await db.notificationRule.create({
      data: { userId: user.id, type: "usage_threshold", config: { percent: [80] } },
    });
    const quota = await db.usageQuota.create({
      data: {
        userId: user.id,
        subscriptionId: sub.id,
        kind: "quota",
        metric: "requests",
        unit: "req",
        limitValue: 100,
        usedValue: 0,
        resetCycle: "monthly",
        periodStart: new Date("2026-08-01T00:00:00Z"),
        periodEnd: new Date("2026-09-01T00:00:00Z"),
      },
    });
    const binding = await db.usageBinding.create({
      data: { userId: user.id, quotaId: quota.id, source: "manual", sourceKey: "form" },
    });
    await db.usageQuota.update({
      where: { id: quota.id },
      data: { authoritativeBindingId: binding.id },
    });

    await ingestReadings(user.id, [
      {
        bindingId: binding.id,
        kind: "quota",
        metric: "requests",
        unit: "req",
        usedValue: "90",
        capturedAt: new Date().toISOString(),
      } as never,
    ]);
    expect((await eventsOf(user.id, "usage_threshold")).length).toBe(1);

    await db.user.delete({ where: { id: user.id } });
  });

  it("price_change: editing price logs PriceChange and emits once", async () => {
    const user = await setupUser();
    const sub = await setupSubscription(user.id);
    await db.notificationRule.create({
      data: { userId: user.id, type: "price_change", config: {} },
    });

    await updateSubscription(user.id, sub.id, { price: 120 });
    const changes = await db.priceChange.findMany({ where: { subscriptionId: sub.id } });
    expect(changes.length).toBe(1);
    expect(changes[0]?.oldPrice.toString()).toBe("100");
    expect(changes[0]?.newPrice.toString()).toBe("120");
    expect(changes[0]?.detectedBy).toBe("user");
    expect((await eventsOf(user.id, "price_change")).length).toBe(1);

    await db.user.delete({ where: { id: user.id } });
  });

  it("connection_failed arms on failure, dedupes on retry, clears on recovery, re-arms", async () => {
    const user = await setupUser();
    const conn = await db.providerConnection.create({
      data: {
        userId: user.id,
        providerId: "deepseek",
        displayName: "ds",
        credentialKeyId: "v1",
        credentialCipher: new Uint8Array([1]),
        credentialIv: new Uint8Array([2]),
        credentialTag: new Uint8Array([3]),
        scopes: [],
        status: "active",
      },
    });
    await db.notificationRule.create({
      data: { userId: user.id, type: "connection_failed", config: {} },
    });

    await notifyConnectionFailed({
      userId: user.id,
      connectionId: conn.id,
      displayName: "ds",
      status: "degraded",
    });
    expect((await eventsOf(user.id, "connection_failed")).length).toBe(1);
    // 同步重试不换 key：不重复报
    await notifyConnectionFailed({
      userId: user.id,
      connectionId: conn.id,
      displayName: "ds",
      status: "degraded",
    });
    expect((await eventsOf(user.id, "connection_failed")).length).toBe(1);

    await clearConnectionFailure({ userId: user.id, connectionId: conn.id });
    const arm = await db.notificationArmState.findFirst({ where: { userId: user.id } });
    expect(arm?.clearedAt).not.toBeNull();

    await notifyConnectionFailed({
      userId: user.id,
      connectionId: conn.id,
      displayName: "ds",
      status: "auth_failed",
    });
    expect((await eventsOf(user.id, "connection_failed")).length).toBe(2);

    await db.user.delete({ where: { id: user.id } });
  });

  it("collector_stale fires once per offline episode, re-fires with a new baseline", async () => {
    const user = await setupUser();
    await db.notificationRule.create({
      data: { userId: user.id, type: "collector_stale", config: { days: 3 } },
    });
    const device = await db.collectorDevice.create({
      data: {
        userId: user.id,
        name: "MacBook",
        platform: "macos",
        agentVersion: "0.1.0",
        publicKey: new Uint8Array(32).fill(1),
        lastSeenAt: new Date(Date.now() - 4 * 86_400_000),
      },
    });

    await runNotificationScan(new Date());
    expect((await eventsOf(user.id, "collector_stale")).length).toBe(1);
    // 同一离线周期（基准未变）：不重复报
    await runNotificationScan(new Date());
    expect((await eventsOf(user.id, "collector_stale")).length).toBe(1);

    // 恢复上报 → 再离线 → 新基准自然换 key
    await db.collectorDevice.update({
      where: { id: device.id },
      data: { lastSeenAt: new Date() },
    });
    const future = new Date(Date.now() + 4 * 86_400_000);
    await runNotificationScan(future);
    expect((await eventsOf(user.id, "collector_stale")).length).toBe(2);

    await db.user.delete({ where: { id: user.id } });
  });
});
