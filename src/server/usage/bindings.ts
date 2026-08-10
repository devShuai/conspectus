import { db } from "@/server/db";

export class BindingError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = "BindingError";
  }
}

/** 通道 B 已知的 collector（与 collector/ 包内的 id 对齐）。 */
export const COLLECTOR_OPTIONS = [
  { id: "codex", displayName: "Codex", metricPrefix: "codex:" },
  { id: "claude-code", displayName: "Claude Code", metricPrefix: "claude:" },
  { id: "kimi-code", displayName: "Kimi Code", metricPrefix: "kimi:" },
] as const;

/**
 * 为一张 quota 指定本地采集器，创建 local binding（design §7.4 Binding 生命周期：
 * 用户在 UI 指定 collector 时创建，记录 collectorId 而非单台设备）。
 * 首个 binding 成为权威来源（§6.2）；重复指定同一 metric 幂等复活。
 */
export async function createLocalBinding(input: {
  userId: string;
  quotaId: string;
  collectorId: string;
  metric: string;
}): Promise<{ bindingId: string }> {
  const collector = COLLECTOR_OPTIONS.find((c) => c.id === input.collectorId);
  if (!collector) {
    throw new BindingError("unknown_collector");
  }
  if (!input.metric.startsWith(collector.metricPrefix)) {
    throw new BindingError("metric_prefix_mismatch");
  }
  const quota = await db.usageQuota.findFirst({
    where: { id: input.quotaId, userId: input.userId },
    select: { id: true, authoritativeBindingId: true },
  });
  if (!quota) {
    throw new BindingError("quota_not_found");
  }

  return db.$transaction(async (tx) => {
    const binding = await tx.usageBinding.upsert({
      where: {
        quotaId_source_sourceKey: {
          quotaId: quota.id,
          source: "local_agent",
          sourceKey: input.metric,
        },
      },
      create: {
        userId: input.userId,
        quotaId: quota.id,
        source: "local_agent",
        sourceKey: input.metric,
        collectorId: collector.id,
      },
      update: { collectorId: collector.id, status: "active" },
      select: { id: true },
    });

    if (!quota.authoritativeBindingId) {
      await tx.usageQuota.update({
        where: { id: quota.id },
        data: { authoritativeBindingId: binding.id },
      });
    }

    return { bindingId: binding.id };
  });
}
