import { describe, expect, it } from "vitest";

import { db } from "@/server/db";

/**
 * 租户外键规则（design §6.2 / #102）：跨用户写入必须被 DB 拒绝，
 * 不能只靠应用层所有权检查。
 */

const DISABLED = !process.env.TEST_DATABASE_URL;

function unique(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function setupUser() {
  return db.user.create({
    data: {
      certusSub: unique("n102"),
      certusLinkStatus: "active",
      lastStatusSyncedAt: new Date(),
      emailVerifiedAt: new Date(),
      emailVerificationSource: "local",
      email: `n102-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
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

describe.skipIf(DISABLED)("tenant FK rules at the DB layer (#102)", () => {
  it("billing record cannot attach to another user's subscription", async () => {
    const a = await setupUser();
    const b = await setupUser();
    const subB = await setupSubscription(b.id);

    await expect(
      db.billingRecord.create({
        data: {
          userId: a.id,
          subscriptionId: subB.id,
          amount: 10,
          currency: "CNY",
          recordType: "charge",
          billedAt: new Date("2026-08-01"),
          status: "paid",
          source: "manual",
        },
      }),
    ).rejects.toThrow(/same user/);
    // 同用户正常写入不受影响
    const subA = await setupSubscription(a.id);
    await expect(
      db.billingRecord.create({
        data: {
          userId: a.id,
          subscriptionId: subA.id,
          amount: 10,
          currency: "CNY",
          recordType: "charge",
          billedAt: new Date("2026-08-01"),
          status: "paid",
          source: "manual",
        },
      }),
    ).resolves.toBeTruthy();

    await db.user.deleteMany({ where: { id: { in: [a.id, b.id] } } });
  });

  it("subscription cannot reference another user's payment method", async () => {
    const a = await setupUser();
    const b = await setupUser();
    const pmB = await db.paymentMethod.create({
      data: { userId: b.id, label: "card", kind: "credit_card" },
    });

    await expect(
      db.subscription.create({
        data: {
          userId: a.id,
          name: "Plan",
          price: 100,
          currency: "CNY",
          billingCycle: "monthly",
          startedAt: new Date("2026-01-01T00:00:00Z"),
          status: "active",
          paymentMethodId: pmB.id,
        },
      }),
    ).rejects.toThrow(/same user/);

    await db.user.deleteMany({ where: { id: { in: [a.id, b.id] } } });
  });

  it("quota cannot point authoritative binding / value snapshot at another quota's rows", async () => {
    const a = await setupUser();
    const b = await setupUser();
    const subA = await setupSubscription(a.id);
    const subB = await setupSubscription(b.id);
    const quotaA = await db.usageQuota.create({
      data: {
        userId: a.id,
        subscriptionId: subA.id,
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
    const quotaB = await db.usageQuota.create({
      data: {
        userId: b.id,
        subscriptionId: subB.id,
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
    const bindingB = await db.usageBinding.create({
      data: { userId: b.id, quotaId: quotaB.id, source: "manual", sourceKey: "form" },
    });

    await expect(
      db.usageQuota.update({
        where: { id: quotaA.id },
        data: { authoritativeBindingId: bindingB.id },
      }),
    ).rejects.toThrow(/same quota and user/);
    // 指向自己 quota 的 binding 正常
    const bindingA = await db.usageBinding.create({
      data: { userId: a.id, quotaId: quotaA.id, source: "manual", sourceKey: "form" },
    });
    await expect(
      db.usageQuota.update({
        where: { id: quotaA.id },
        data: { authoritativeBindingId: bindingA.id },
      }),
    ).resolves.toBeTruthy();

    await db.user.deleteMany({ where: { id: { in: [a.id, b.id] } } });
  });

  it("arm state cannot reference another user's rule (composite FK)", async () => {
    const a = await setupUser();
    const b = await setupUser();
    const ruleB = await db.notificationRule.create({
      data: { userId: b.id, type: "balance_low", config: {} },
    });

    await expect(
      db.notificationArmState.create({
        data: {
          userId: a.id,
          ruleId: ruleB.id,
          subjectType: "quota",
          subjectId: a.id, // 任意 uuid，FK 只查 (userId, ruleId)
          armedAt: new Date(),
          armKey: "k1",
        },
      }),
    ).rejects.toThrow();

    await db.user.deleteMany({ where: { id: { in: [a.id, b.id] } } });
  });
});
