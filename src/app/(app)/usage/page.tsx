import { redirect } from "next/navigation";

import { currentAppSession } from "@/server/auth/current-session";
import { listSubscriptions } from "@/server/billing/subscriptions";
import { db } from "@/server/db";

export const dynamic = "force-dynamic";

export default async function UsagePage() {
  const session = await currentAppSession();
  if (!session) redirect("/");

  const [subs, quotas, connections] = await Promise.all([
    listSubscriptions(session.userId),
    db.usageQuota.findMany({
      where: { userId: session.userId },
      include: { bindings: true, cycleSummaries: { orderBy: { periodStart: "desc" }, take: 3 } },
      orderBy: { createdAt: "desc" },
    }),
    db.providerConnection.findMany({ where: { userId: session.userId } }),
  ]);

  const subName = new Map(subs.map((s) => [s.id, s.name]));

  return (
    <main className="shell">
      <p className="eyebrow">用量中心</p>
      <h1>用量额度</h1>

      {quotas.length === 0 && <p className="muted">暂无用量卡。手动录入或连接服务商后显示。</p>}

      <div className="usage-grid">
        {quotas.map((quota) => {
          const used = Number(quota.usedValue ?? quota.remainingValue ?? 0);
          const limit = Number(quota.limitValue ?? 0);
          const pct = limit > 0 ? Math.round((used / limit) * 100) : null;
          const auth = quota.authoritativeBindingId
            ? quota.bindings.find((b) => b.id === quota.authoritativeBindingId)
            : null;
          return (
            <div key={quota.id} className="usage-card">
              <div className="usage-card-head">
                <span className="tag">{quota.kind}</span>
                <span className="usage-metric">{quota.metric}</span>
              </div>
              <div className="stat-value">
                {quota.kind === "balance"
                  ? `${quota.remainingValue} ${quota.unit}`
                  : `${quota.usedValue} / ${quota.limitValue ?? "∞"} ${quota.unit}`}
              </div>
              {pct !== null && (
                <div
                  className="usage-bar"
                  role="progressbar"
                  aria-valuenow={pct}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label={`${quota.metric} 已用 ${pct}%`}
                >
                  <div
                    className={`usage-fill${pct >= 80 ? " warn" : ""}`}
                    style={{ width: `${Math.min(pct, 100)}%` }}
                  />
                </div>
              )}
              <div className="usage-meta">
                来源：{auth?.source ?? "—"} · 订阅：{subName.get(quota.subscriptionId) ?? "—"}
              </div>
              {quota.cycleSummaries.length > 0 && (
                <div className="usage-meta">
                  近 3 周期利用率：
                  {quota.cycleSummaries
                    .map((c) => `${Math.round(Number(c.utilizationAtClose ?? 0) * 100)}%`)
                    .join(" / ")}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <h2>服务商连接</h2>
      <table className="data-table">
        <thead>
          <tr><th>服务商</th><th>状态</th><th>上次同步</th><th>下次同步</th><th>错误</th></tr>
        </thead>
        <tbody>
          {connections.map((conn) => (
            <tr key={conn.id}>
              <td>{conn.displayName}</td>
              <td><span className="tag">{conn.status}</span></td>
              <td>{conn.lastSyncAt?.toISOString() ?? "—"}</td>
              <td>{conn.nextSyncAt?.toISOString() ?? "—"}</td>
              <td>{conn.lastError ?? "—"}</td>
            </tr>
          ))}
          {connections.length === 0 && (
            <tr><td colSpan={5} className="muted">未连接任何服务商</td></tr>
          )}
        </tbody>
      </table>
    </main>
  );
}
