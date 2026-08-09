import { redirect } from "next/navigation";

import {
  LocalBindingForm,
  ManualQuotaForm,
  ManualUsageUpdateForm,
} from "@/components/settings/usage-forms";
import { currentAppSession } from "@/server/auth/current-session";
import { formatDateTime } from "@/components/datetime";
import { formatMoney } from "@/components/money";
import { db } from "@/server/db";
import { COLLECTOR_OPTIONS } from "@/server/usage/bindings";
import {
  createLocalBindingAction,
  createManualQuotaAction,
  updateManualUsageAction,
} from "@/server/settings/actions";

export const dynamic = "force-dynamic";

export default async function UsageEntryPage() {
  const session = await currentAppSession();
  if (!session) redirect("/login");

  const [subscriptions, quotas, user] = await Promise.all([
    db.subscription.findMany({
      where: { userId: session.userId },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
    db.usageQuota.findMany({
      where: { userId: session.userId },
      orderBy: { createdAt: "asc" },
      include: {
        subscription: { select: { name: true } },
        bindings: {
          select: { id: true, source: true, sourceKey: true, status: true },
        },
      },
    }),
    db.user.findUnique({
      where: { id: session.userId },
      select: { timezone: true },
    }),
  ]);
  const timezone = user?.timezone ?? "UTC";

  const collectors = COLLECTOR_OPTIONS.map((c) => ({
    id: c.id,
    displayName: c.displayName,
    metricPrefix: c.metricPrefix,
  }));

  return (
    <main className="shell">
      <p className="eyebrow">设置 / 用量录入</p>
      <h1>手动录入用量</h1>
      <p className="muted">
        手动录入是三条采集通道的兜底（design §7.4）：不装 CLI、没有公开 API 时随时可用。
      </p>

      <h2>现有额度</h2>
      {quotas.length === 0 && <p className="muted">暂无额度，先在下方创建。</p>}
      <div className="usage-grid">
        {quotas.map((quota) => (
          <div key={quota.id} className="usage-card">
            <div className="usage-card-head">
              <span className="usage-metric">
                {quota.subscription.name} · {quota.metric}
              </span>
              <span className="tag">{quota.kind}</span>
            </div>
            <p className="usage-meta">
              {quota.kind === "balance"
                ? `剩余 ${quota.remainingValue ? formatMoney(Number(quota.remainingValue), quota.unit) : "—"}`
                : `已用 ${quota.usedValue?.toString() ?? "—"}${quota.limitValue ? ` / ${quota.limitValue.toString()}` : ""} ${quota.unit}`}
              {quota.valueCapturedAt &&
                ` · ${formatDateTime(quota.valueCapturedAt, timezone)}`}
            </p>
            {quota.bindings.length > 0 && (
              <p className="usage-meta">
                绑定：
                {quota.bindings
                  .map((b) => `${b.source}:${b.sourceKey}${b.status === "revoked" ? "（已撤销）" : ""}`)
                  .join(" · ")}
              </p>
            )}
            <ManualUsageUpdateForm
              action={updateManualUsageAction}
              quotaId={quota.id}
              kind={quota.kind}
            />
            <LocalBindingForm
              action={createLocalBindingAction}
              quotaId={quota.id}
              collectors={collectors}
            />
          </div>
        ))}
      </div>

      <h2>创建额度</h2>
      {subscriptions.length === 0 ? (
        <p className="muted">先创建一条订阅，才能为它建额度。</p>
      ) : (
        <ManualQuotaForm action={createManualQuotaAction} subscriptions={subscriptions} />
      )}
    </main>
  );
}
