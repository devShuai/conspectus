import { redirect } from "next/navigation";

import { currentAppSession } from "@/server/auth/current-session";
import { listSubscriptions } from "@/server/billing/subscriptions";
import { dashboardStats } from "@/server/billing/stats";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const session = await currentAppSession();
  if (!session) redirect("/");

  const [subs, stats] = await Promise.all([
    listSubscriptions(session.userId),
    dashboardStats(session.userId),
  ]);

  return (
    <main className="shell">
      <p className="eyebrow">订阅资产管理中心</p>
      <h1>财务总览</h1>
      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-label">本月净支出</div>
          <div className="stat-value">
            ¥{stats.monthNetSpend.toFixed(2)}
            {stats.incomplete && (
              <span className="stat-warn"> 缺 {stats.missingProjections} 条投影</span>
            )}
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-label">年化成本</div>
          <div className="stat-value">¥{stats.annualized.toFixed(2)}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">预计将付</div>
          <div className="stat-value">¥{stats.pendingEstimate.toFixed(2)}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">订阅</div>
          <div className="stat-value">
            {subs.length} <span className="stat-sub">（试用 {stats.trialCount}）</span>
          </div>
        </div>
      </div>

      <h2>订阅列表</h2>
      <table className="data-table">
        <thead>
          <tr>
            <th>名称</th>
            <th>状态</th>
            <th>价格</th>
            <th>周期</th>
            <th>下次缴费</th>
          </tr>
        </thead>
        <tbody>
          {subs.map((sub) => (
            <tr key={sub.id}>
              <td>{sub.name}</td>
              <td>
                <span className="tag">{sub.status}</span>
                {sub.status === "trial" && <span className="tag warn">试用中</span>}
              </td>
              <td>
                {sub.currency} {sub.price.toString()}
              </td>
              <td>{sub.billingCycle}</td>
              <td>
                {sub.nextBillingAt
                  ? sub.nextBillingAt.toISOString().slice(0, 10)
                  : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {subs.length === 0 && <p className="muted">暂无订阅，等待录入。</p>}
    </main>
  );
}
