import { describe, expect, it } from "vitest";

import { db } from "@/server/db";

import { BindingError, createLocalBinding } from "./bindings";
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
      unit: "次",
      limitValue: 500,
      usedValue: 0,
      resetCycle: "monthly",
      periodStart: new Date("2026-01-01T00:00:00Z"),
      periodEnd: new Date("2026-02-01T00:00:00Z"),
    });
    return { user, sub, quotaId };
  }

  it("creates a local binding and makes it authoritative when none exists", async () => {
    const { user, quotaId } = await setup();
    const { bindingId } = await createLocalBinding({
      userId: user.id,
      quotaId,
      collectorId: "claude-code",
      metric: "claude:requests",
    });

    const binding = await db.usageBinding.findUniqueOrThrow({ where: { id: bindingId } });
    expect(binding.source).toBe("local_agent");
    expect(binding.sourceKey).toBe("claude:requests");
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
      metric: "claude:requests",
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
      metric: "codex:tokens",
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
});
