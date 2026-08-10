import { db } from "@/server/db";

export class BindingError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = "BindingError";
  }
}

/**
 * 通道 B 的服务端目录。UI 与 collector manifest 共用这组稳定 metric，避免自由文本
 * 创建出 collector 永远不会上报的 binding。MiniMax 运行在服务端，不属于此目录。
 */
export const COLLECTOR_OPTIONS = [
  {
    id: "codex",
    displayName: "Codex",
    metricPrefix: "codex:",
    description: "支持 Codex 桌面版与 CLI，读取已登录账号的额度窗口。",
    metrics: [
      { id: "codex:5h", label: "5 小时额度", kind: "quota", unit: "%", resetCycle: "never", initialLimit: 100, durationMinutes: 300 },
      { id: "codex:weekly", label: "每周额度", kind: "quota", unit: "%", resetCycle: "never", initialLimit: 100, durationMinutes: 10_080 },
      { id: "codex:tokens", label: "生命周期 Tokens", kind: "counter", unit: "tok", resetCycle: "never" },
    ],
  },
  {
    id: "claude-code",
    displayName: "Claude",
    metricPrefix: "claude:",
    description:
      "额度与 Claude 桌面版、Claude Code 共享；Windows 安全存储不向外部采集器开放，需运行 claude setup-token 并设置 CLAUDE_CODE_OAUTH_TOKEN。",
    metrics: [
      { id: "claude:five_hour", label: "5 小时额度", kind: "quota", unit: "%", resetCycle: "never", initialLimit: 100, durationMinutes: 300 },
      { id: "claude:seven_day", label: "7 天额度", kind: "quota", unit: "%", resetCycle: "never", initialLimit: 100, durationMinutes: 10_080 },
    ],
  },
  {
    id: "kimi-code",
    displayName: "Kimi Code",
    metricPrefix: "kimi:",
    description:
      "复用 ~/.kimi-code 的现有 OAuth 登录并自动刷新，无需再次 kimi login；采集 Coding Plan 的 5 小时与每周额度。",
    metrics: [
      { id: "kimi:5h", label: "5 小时额度", kind: "quota", unit: "req", resetCycle: "never", initialLimit: 1, durationMinutes: 300 },
      { id: "kimi:weekly", label: "每周额度", kind: "quota", unit: "req", resetCycle: "never", initialLimit: 1, durationMinutes: 10_080 },
    ],
  },
] as const;

export type LocalCollectorId = (typeof COLLECTOR_OPTIONS)[number]["id"];

/**
 * 删除一项用户用量指标。UsageQuota 是指标聚合根；数据库会级联删除它的
 * bindings、snapshots 与 cycle summaries。deleteMany 把租户条件放在同一条
 * DELETE 中，避免先查后删产生越权竞态。
 */
export async function deleteUsageMetric(input: {
  userId: string;
  quotaId: string;
}): Promise<void> {
  const deleted = await db.usageQuota.deleteMany({
    where: { id: input.quotaId, userId: input.userId },
  });
  if (deleted.count !== 1) throw new BindingError("quota_not_found");
}

function metricDefinition(collectorId: string, metric: string) {
  const collector = COLLECTOR_OPTIONS.find((item) => item.id === collectorId);
  return collector?.metrics.find((item) => item.id === metric);
}

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
  const definition = metricDefinition(input.collectorId, input.metric);
  if (!definition) {
    throw new BindingError("unsupported_metric");
  }
  const quota = await db.usageQuota.findFirst({
    where: { id: input.quotaId, userId: input.userId },
    select: { id: true, kind: true, unit: true, authoritativeBindingId: true },
  });
  if (!quota) {
    throw new BindingError("quota_not_found");
  }
  if (quota.kind !== definition.kind || quota.unit !== definition.unit) {
    throw new BindingError("metric_conflict");
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

/**
 * UI 闭环入口：从目录模板直接创建 quota + local binding。新 quota 不经过 manual
 * binding，因此首次 CLI 上报就是当前值；复用旧 quota 时不静默抢占已有权威来源。
 */
export async function createLocalCollectorSetup(input: {
  userId: string;
  subscriptionId: string;
  collectorId: string;
  metrics: string[];
}): Promise<{ created: number; authorityNeedsConfirmation: number }> {
  const collector = COLLECTOR_OPTIONS.find((item) => item.id === input.collectorId);
  if (!collector) throw new BindingError("unknown_collector");
  const requested = [...new Set(input.metrics)];
  if (requested.length === 0) throw new BindingError("metrics_required");
  const definitions = requested.map((metric) => metricDefinition(input.collectorId, metric));
  if (definitions.some((definition) => !definition)) {
    throw new BindingError("unsupported_metric");
  }

  const subscription = await db.subscription.findFirst({
    where: { id: input.subscriptionId, userId: input.userId },
    select: { id: true },
  });
  if (!subscription) throw new BindingError("subscription_not_found");

  return db.$transaction(async (tx) => {
    let created = 0;
    let authorityNeedsConfirmation = 0;
    for (const definition of definitions) {
      if (!definition) continue;
      let quota = await tx.usageQuota.findUnique({
        where: { subscriptionId_metric: { subscriptionId: subscription.id, metric: definition.id } },
        select: { id: true, kind: true, unit: true, authoritativeBindingId: true },
      });
      if (quota && (quota.kind !== definition.kind || quota.unit !== definition.unit)) {
        throw new BindingError("metric_conflict");
      }
      if (!quota) {
        const now = new Date();
        quota = await tx.usageQuota.create({
          data: {
            userId: input.userId,
            subscriptionId: subscription.id,
            metric: definition.id,
            kind: definition.kind,
            unit: definition.unit,
            resetCycle: definition.resetCycle,
            usedValue: 0,
            ...(definition.kind === "quota"
              ? {
                  limitValue: definition.initialLimit,
                  periodStart: now,
                  periodEnd: new Date(now.getTime() + definition.durationMinutes * 60_000),
                }
              : {}),
          },
          select: { id: true, kind: true, unit: true, authoritativeBindingId: true },
        });
        created++;
      }

      const binding = await tx.usageBinding.upsert({
        where: {
          quotaId_source_sourceKey: {
            quotaId: quota.id,
            source: "local_agent",
            sourceKey: definition.id,
          },
        },
        create: {
          userId: input.userId,
          quotaId: quota.id,
          source: "local_agent",
          sourceKey: definition.id,
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
      } else if (quota.authoritativeBindingId !== binding.id) {
        authorityNeedsConfirmation++;
      }
    }
    return { created, authorityNeedsConfirmation };
  });
}
