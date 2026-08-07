import { db } from "@/server/db";
import type { UsageKind, UsageResetCycle } from "@prisma/client";
import { ingestReadings } from "./ingest";
import { UsageReadingSchema } from "./reading";

export class ManualUsageError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = "ManualUsageError";
  }
}

export interface CreateQuotaInput {
  userId: string;
  subscriptionId: string;
  kind: UsageKind;
  metric: string;
  unit: string;
  limitValue?: number;
  usedValue?: number;
  remainingValue?: number;
  resetCycle: UsageResetCycle;
  periodStart?: Date;
  periodEnd?: Date;
}

/**
 * Channel C: create a quota with a server-generated manual binding.
 * The binding id is never client-editable.
 */
export async function createManualQuota(input: CreateQuotaInput): Promise<{ quotaId: string }> {
  const sub = await db.subscription.findFirst({
    where: { id: input.subscriptionId, userId: input.userId },
  });
  if (!sub) throw new ManualUsageError("subscription_not_found");

  const quota = await db.$transaction(async (tx) => {
    const created = await tx.usageQuota.create({
      data: {
        userId: input.userId,
        subscriptionId: input.subscriptionId,
        kind: input.kind,
        metric: input.metric,
        unit: input.unit,
        limitValue: input.limitValue,
        usedValue: input.usedValue,
        remainingValue: input.remainingValue,
        resetCycle: input.resetCycle,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
      },
    });
    const binding = await tx.usageBinding.create({
      data: {
        userId: input.userId,
        quotaId: created.id,
        source: "manual",
        sourceKey: "form",
      },
    });
    await tx.usageQuota.update({
      where: { id: created.id },
      data: { authoritativeBindingId: binding.id },
    });
    return created;
  });
  return { quotaId: quota.id };
}

/** Manual update through the manual binding (never exposes binding id). */
export async function updateManualUsage(input: {
  userId: string;
  quotaId: string;
  usedValue?: number;
  remainingValue?: number;
  capturedAt?: Date;
}): Promise<void> {
  const binding = await db.usageBinding.findFirst({
    where: { quotaId: input.quotaId, userId: input.userId, source: "manual" },
    include: { quota: true },
  });
  if (!binding) throw new ManualUsageError("manual_binding_not_found");

  const reading = UsageReadingSchema.parse({
    bindingId: binding.id,
    kind: binding.quota.kind,
    metric: binding.quota.metric,
    unit: binding.quota.unit,
    usedValue: input.usedValue?.toString(),
    remainingValue: input.remainingValue?.toString(),
    capturedAt: (input.capturedAt ?? new Date()).toISOString(),
  });
  const result = await ingestReadings(input.userId, [reading]);
  if (result.accepted !== 1) {
    throw new ManualUsageError(result.rejected[0]?.reason ?? "rejected");
  }
}

/**
 * Close a quota cycle: write UsageCycleSummary (fixed utilization) and reset
 * usedValue for the next period. Never recomputes historical summaries.
 */
export async function closeQuotaCycle(
  userId: string,
  quotaId: string,
  now: Date = new Date(),
): Promise<void> {
  await db.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<
      Array<{ id: string }>
    >`SELECT id FROM "usage_quotas" WHERE id = ${quotaId}::uuid FOR UPDATE`;
    if (locked.length !== 1) throw new ManualUsageError("quota_not_found");
    const quota = await tx.usageQuota.findUnique({ where: { id: quotaId } });
    if (!quota || quota.userId !== userId) throw new ManualUsageError("quota_not_found");
    if (quota.kind !== "quota" || !quota.periodEnd || !quota.limitValue) {
      throw new ManualUsageError("only quota kind with period can close");
    }

    const finalValue = quota.usedValue ?? 0;
    const limit = quota.limitValue;
    await tx.usageCycleSummary.create({
      data: {
        userId,
        quotaId,
        periodStart: quota.periodStart ?? now,
        periodEnd: quota.periodEnd,
        finalValue,
        limitValueAtClose: limit,
        utilizationAtClose:
          Number(limit) > 0 ? Number(finalValue) / Number(limit) : null,
        unitAtClose: quota.unit,
        authoritativeBindingIdAtClose: quota.authoritativeBindingId,
      },
    }).catch(() => undefined); // unique (quotaId, periodStart)

    await tx.usageQuota.update({
      where: { id: quotaId },
      data: {
        usedValue: 0,
        periodStart: quota.periodEnd,
        periodEnd: nextPeriod(quota.periodEnd, quota.resetCycle),
      },
    });
  });
}

function nextPeriod(from: Date, cycle: UsageResetCycle): Date {
  switch (cycle) {
    case "daily":
      return new Date(from.getTime() + 86_400_000);
    case "weekly":
      return new Date(from.getTime() + 7 * 86_400_000);
    case "monthly":
      return new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1));
    default:
      return from;
  }
}

/** Idle detection: last N closed cycles utilization < threshold. */
export async function idleCandidates(
  userId: string,
  threshold = 0.1,
  consecutive = 3,
): Promise<Array<{ quotaId: string; metric: string; recentUtilization: number }>> {
  const quotas = await db.usageQuota.findMany({
    where: { userId, kind: "quota" },
    select: { id: true, metric: true },
  });
  const result: Array<{ quotaId: string; metric: string; recentUtilization: number }> = [];
  for (const quota of quotas) {
    const summaries = await db.usageCycleSummary.findMany({
      where: { quotaId: quota.id, utilizationAtClose: { not: null } },
      orderBy: { periodStart: "desc" },
      take: consecutive,
    });
    if (summaries.length < consecutive) continue;
    const recent = summaries.reduce((sum, s) => sum + Number(s.utilizationAtClose ?? 0), 0) / summaries.length;
    if (summaries.every((s) => Number(s.utilizationAtClose ?? 1) < threshold)) {
      result.push({ quotaId: quota.id, metric: quota.metric, recentUtilization: recent });
    }
  }
  return result;
}
