import { db } from "@/server/db";

import { clearArm, emitArmedEvent, emitEvent } from "./scan";

/**
 * 用量类规则求值（design §7.6 / #114）：
 * - `usage_threshold`（仅 kind=quota）：percent 数组，达到即报，dedupeKey 用
 *   `<periodStart>:p<n>`——周期重置即换 key，自然重新武装，不需要 ArmState
 * - `balance_low`（仅 kind=balance）：无自然周期，状态落 NotificationArmState；
 *   迟滞 ×1.1 恢复后 clear，下次再跌破可重新武装
 */

const BALANCE_RECOVERY_HYSTERESIS = 1.1;

export async function evaluateUsageRules(
  userId: string,
  quotaIds: string[],
  now: Date = new Date(),
): Promise<void> {
  if (quotaIds.length === 0) return;
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { status: true, timezone: true },
  });
  if (!user || user.status === "suspended") return;

  const quotas = await db.usageQuota.findMany({
    where: { id: { in: [...new Set(quotaIds)] }, userId },
    include: { subscription: { select: { name: true } } },
  });

  for (const quota of quotas) {
    if (quota.kind === "quota") {
      await evaluateUsageThreshold(userId, quota, now);
    } else if (quota.kind === "balance") {
      await evaluateBalanceLow(userId, quota, now);
    }
  }
}

type QuotaWithSub = {
  id: string;
  userId: string;
  subscriptionId: string;
  kind: string;
  metric: string;
  unit: string;
  usedValue: unknown;
  limitValue: unknown;
  remainingValue: unknown;
  periodStart: Date | null;
  subscription: { name: string };
};

async function evaluateUsageThreshold(
  userId: string,
  quota: QuotaWithSub,
  now: Date,
): Promise<void> {
  const used = Number(quota.usedValue ?? NaN);
  const limit = Number(quota.limitValue ?? 0);
  if (!Number.isFinite(used) || limit <= 0) return;
  const pct = (used / limit) * 100;

  const rules = await db.notificationRule.findMany({
    where: {
      userId,
      type: "usage_threshold",
      enabled: true,
      OR: [{ subscriptionId: null }, { subscriptionId: quota.subscriptionId }],
    },
  });
  for (const rule of rules) {
    const percents = ((rule.config as { percent?: number[] }).percent ?? [80, 95])
      .filter((p) => Number.isFinite(p))
      .sort((a, b) => a - b);
    for (const p of percents) {
      if (pct < p) continue;
      const periodKey = quota.periodStart
        ? quota.periodStart.toISOString().slice(0, 10)
        : "none";
      // 自然周期 dedupe（§7.6）：periodStart 换 key，周期重置后自然再报
      await emitEvent({
        userId,
        ruleId: rule.id,
        subjectType: "quota",
        subjectId: quota.id,
        dedupeKey: `${periodKey}:p${p}`,
        payload: {
          quotaId: quota.id,
          name: quota.subscription.name,
          metric: quota.metric,
          percent: Math.round(pct),
          threshold: p,
          usedValue: String(quota.usedValue),
          limitValue: String(quota.limitValue),
          unit: quota.unit,
        },
        occurredAt: now,
      });
    }
  }
}

async function evaluateBalanceLow(
  userId: string,
  quota: QuotaWithSub,
  now: Date,
): Promise<void> {
  const remaining = Number(quota.remainingValue ?? NaN);
  if (!Number.isFinite(remaining)) return;

  const rules = await db.notificationRule.findMany({
    where: {
      userId,
      type: "balance_low",
      enabled: true,
      OR: [{ subscriptionId: null }, { subscriptionId: quota.subscriptionId }],
    },
  });
  for (const rule of rules) {
    const config = rule.config as { minValue?: number; minDaysLeft?: number };
    const minValue = config.minValue ?? null;
    const daysLeft = await estimateDaysLeft(quota, now);
    const minDaysLeft = config.minDaysLeft ?? null;

    const isLow =
      (minValue !== null && remaining <= minValue) ||
      (minDaysLeft !== null && daysLeft !== null && daysLeft <= minDaysLeft);
    const recovered =
      (minValue !== null && remaining > minValue * BALANCE_RECOVERY_HYSTERESIS) ||
      (minDaysLeft !== null && daysLeft !== null && daysLeft > minDaysLeft);

    if (isLow) {
      await emitArmedEvent({
        userId,
        ruleId: rule.id,
        subjectType: "quota",
        subjectId: quota.id,
        dedupeKey: `balance_low:${rule.id}:${quota.id}:${now.toISOString().slice(0, 13)}`,
        arm: { armKey: `bal:${now.getTime()}` },
        payload: {
          quotaId: quota.id,
          name: quota.subscription.name,
          metric: quota.metric,
          remainingValue: String(quota.remainingValue),
          unit: quota.unit,
          minValue,
          daysLeft,
          minDaysLeft,
        },
        occurredAt: now,
      });
    } else if (recovered) {
      await clearArm({ ruleId: rule.id, subjectType: "quota", subjectId: quota.id, now });
    }
  }
}

/** 由最近两条快照估算剩余可用天数；数据不足返回 null（#118 再做完整线性外推）。 */
async function estimateDaysLeft(
  quota: { id: string; remainingValue: unknown },
  now: Date,
): Promise<number | null> {
  const snapshots = await db.usageSnapshot.findMany({
    where: { quotaId: quota.id },
    orderBy: { capturedAt: "desc" },
    take: 2,
  });
  if (snapshots.length < 2) return null;
  const [latest, previous] = snapshots;
  const burn = Number(previous.value) - Number(latest.value); // balance 递减为正
  const hours = (latest.capturedAt.getTime() - previous.capturedAt.getTime()) / 3_600_000;
  if (burn <= 0 || hours <= 0) return null;
  const remaining = Number(latest.value);
  return remaining / (burn / hours) / 24;
}

/** connection_failed 求值入口（§7.6 / #114）：连接转入 auth_failed / degraded 时 armed。 */
export async function notifyConnectionFailed(input: {
  userId: string;
  connectionId: string;
  displayName: string;
  status: string;
  now?: Date;
}): Promise<void> {
  const now = input.now ?? new Date();
  const rules = await db.notificationRule.findMany({
    where: { userId: input.userId, type: "connection_failed", enabled: true },
  });
  for (const rule of rules) {
    await emitArmedEvent({
      userId: input.userId,
      ruleId: rule.id,
      subjectType: "connection",
      subjectId: input.connectionId,
      dedupeKey: `connfail:${rule.id}:${input.connectionId}:${now.toISOString().slice(0, 13)}`,
      arm: { armKey: `conn:${now.getTime()}` },
      payload: {
        connectionId: input.connectionId,
        displayName: input.displayName,
        status: input.status,
      },
      occurredAt: now,
    });
  }
}

/** 连接恢复（同步成功）后清除武装；同步重试不换 key（§7.6）。 */
export async function clearConnectionFailure(input: {
  userId: string;
  connectionId: string;
  now?: Date;
}): Promise<void> {
  const now = input.now ?? new Date();
  const rules = await db.notificationRule.findMany({
    where: { userId: input.userId, type: "connection_failed", enabled: true },
  });
  for (const rule of rules) {
    await clearArm({
      ruleId: rule.id,
      subjectType: "connection",
      subjectId: input.connectionId,
      now,
    });
  }
}

/** price_change 求值入口（§7.6 / #114）：在 PriceChange 创建后调用。 */
export async function notifyPriceChange(input: {
  userId: string;
  priceChangeId: string;
  subscriptionId: string;
  name: string;
  vendor: string | null;
  oldPrice: string;
  newPrice: string;
  currency: string;
  detectedBy: string;
  effectiveAt: Date;
  now?: Date;
}): Promise<void> {
  const now = input.now ?? new Date();
  const rules = await db.notificationRule.findMany({
    where: {
      userId: input.userId,
      type: "price_change",
      enabled: true,
      OR: [{ subscriptionId: null }, { subscriptionId: input.subscriptionId }],
    },
  });
  for (const rule of rules) {
    // PriceChange 行本身一次性：dedupeKey 固定串，重跑幂等（§7.6）
    await emitEvent({
      userId: input.userId,
      ruleId: rule.id,
      subjectType: "priceChange",
      subjectId: input.priceChangeId,
      dedupeKey: "once",
      payload: {
        priceChangeId: input.priceChangeId,
        name: input.name,
        vendor: input.vendor,
        oldPrice: input.oldPrice,
        newPrice: input.newPrice,
        currency: input.currency,
        detectedBy: input.detectedBy,
        effectiveAt: input.effectiveAt.toISOString().slice(0, 10),
      },
      occurredAt: now,
    });
  }
}
