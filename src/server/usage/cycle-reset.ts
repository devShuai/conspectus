import { db } from "@/server/db";

import { ManualUsageError, closeQuotaCycle } from "./manual";

const MAX_CATCHUP_CYCLES = 36;

/**
 * 周期重置 runner（design §7.4 / #117）：纯手工 quota 到期归零并开新周期，
 * 重置事务写 UsageCycleSummary（finalValue/limit/unit/权威/utilizationAtClose）。
 * provider/local 权威来源的 period 由数据源读数驱动，不由本任务重置。
 */
export async function resetDueQuotaCycles(now: Date = new Date()): Promise<{
  closed: number;
}> {
  const due = await db.usageQuota.findMany({
    where: {
      kind: "quota",
      resetCycle: { not: "never" },
      periodEnd: { not: null, lte: now },
    },
    orderBy: { periodEnd: "asc" },
    take: 200,
  });

  let closed = 0;
  for (const quota of due) {
    const binding = quota.authoritativeBindingId
      ? await db.usageBinding.findUnique({
          where: { id: quota.authoritativeBindingId },
          select: { source: true },
        })
      : null;
    // 权威是 provider/local → 周期由数据源驱动；只重置纯手动 quota（§7.4）
    if (binding && binding.source !== "manual") continue;

    let current = quota;
    let guard = 0;
    while (current.periodEnd && current.periodEnd <= now && guard < MAX_CATCHUP_CYCLES) {
      try {
        await closeQuotaCycle(quota.userId, quota.id, now);
        closed++;
      } catch (cause) {
        // 到期清单加载后 quota 被并发删除/归档是生产常态（用户删号、删订阅），跳过即可
        if (cause instanceof ManualUsageError && cause.reason === "quota_not_found") break;
        throw cause;
      }
      current = await db.usageQuota.findUniqueOrThrow({ where: { id: quota.id } });
      guard++;
    }
  }
  return { closed };
}
