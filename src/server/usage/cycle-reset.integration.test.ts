import { describe, expect, it } from "vitest";

import { db } from "@/server/db";

import { resetDueQuotaCycles } from "./cycle-reset";
import { createManualQuota } from "./manual";

const DISABLED = !process.env.TEST_DATABASE_URL;

function unique(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function setup(periodStart: Date, periodEnd: Date) {
  const user = await db.user.create({
    data: {
      certusSub: unique("cr"),
      certusLinkStatus: "active",
      lastStatusSyncedAt: new Date(),
    },
  });
  const sub = await db.subscription.create({
    data: {
      userId: user.id,
      name: "Plan",
      status: "active",
      price: 100,
      currency: "CNY",
      billingCycle: "monthly",
      startedAt: new Date("2026-01-01T00:00:00Z"),
    },
  });
  const { quotaId } = await createManualQuota({
    userId: user.id,
    subscriptionId: sub.id,
    kind: "quota",
    metric: "requests",
    unit: "次",
    limitValue: 100,
    usedValue: 30,
    resetCycle: "monthly",
    periodStart,
    periodEnd,
  });
  return { user, sub, quotaId };
}

describe.skipIf(DISABLED)("quota cycle reset (#117)", () => {
  it("closes a due manual quota: summary fixed, used reset, period advanced", async () => {
    const { user, quotaId } = await setup(
      new Date("2026-07-01T00:00:00Z"),
      new Date("2026-08-01T00:00:00Z"),
    );
    const now = new Date("2026-08-08T00:00:00Z");

    // 共享库中其他测试的到期 quota 也会被处理，断言一律只看本条 quota
    await resetDueQuotaCycles(now);

    const summary = await db.usageCycleSummary.findFirstOrThrow({
      where: { quotaId },
    });
    expect(summary.finalValue?.toString()).toBe("30");
    expect(summary.limitValueAtClose?.toString()).toBe("100");
    expect(Number(summary.utilizationAtClose)).toBeCloseTo(0.3, 6);
    expect(summary.unitAtClose).toBe("次");
    expect(summary.authoritativeBindingIdAtClose).not.toBeNull();
    expect(summary.periodEnd).toEqual(new Date("2026-08-01T00:00:00Z"));

    const quota = await db.usageQuota.findUniqueOrThrow({ where: { id: quotaId } });
    expect(quota.usedValue?.toString()).toBe("0");
    expect(quota.periodStart).toEqual(new Date("2026-08-01T00:00:00Z"));
    expect(quota.periodEnd).toEqual(new Date("2026-09-01T00:00:00Z"));

    // 幂等：周期已推进到未来，重跑不再为本 quota 建汇总
    await resetDueQuotaCycles(now);
    expect(await db.usageCycleSummary.count({ where: { quotaId } })).toBe(1);

    await db.user.delete({ where: { id: user.id } });
  });

  it("catches up multiple missed cycles", async () => {
    const { user, quotaId } = await setup(
      new Date("2026-04-01T00:00:00Z"),
      new Date("2026-05-01T00:00:00Z"),
    );
    const now = new Date("2026-08-08T00:00:00Z");

    await resetDueQuotaCycles(now);
    // 5/1、6/1、7/1、8/1 四个 periodEnd 到期，各落一条汇总
    const summaries = await db.usageCycleSummary.findMany({ where: { quotaId } });
    expect(summaries.length).toBe(4);

    const quota = await db.usageQuota.findUniqueOrThrow({ where: { id: quotaId } });
    expect(quota.periodEnd).toEqual(new Date("2026-09-01T00:00:00Z"));

    await db.user.delete({ where: { id: user.id } });
  });

  it("skips quotas whose authoritative source is provider/local (data source owns the period)", async () => {
    const { user, quotaId } = await setup(
      new Date("2026-07-01T00:00:00Z"),
      new Date("2026-08-01T00:00:00Z"),
    );
    const providerBinding = await db.usageBinding.create({
      data: {
        userId: user.id,
        quotaId,
        source: "provider",
        sourceKey: "credit",
      },
    });
    await db.usageQuota.update({
      where: { id: quotaId },
      data: { authoritativeBindingId: providerBinding.id },
    });

    await resetDueQuotaCycles(new Date("2026-08-08T00:00:00Z"));
    // 本 quota 不被重置：无汇总、usedValue 保持 30
    expect(await db.usageCycleSummary.count({ where: { quotaId } })).toBe(0);
    const quota = await db.usageQuota.findUniqueOrThrow({ where: { id: quotaId } });
    expect(quota.usedValue?.toString()).toBe("30");

    await db.user.delete({ where: { id: user.id } });
  });
});
