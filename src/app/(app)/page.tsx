import { redirect } from "next/navigation";
import Link from "next/link";

import { currentAppSession } from "@/server/auth/current-session";
import EmptyState from "@/components/empty-state";
import { formatMoney } from "@/components/money";
import { listSubscriptions } from "@/server/billing/subscriptions";
import { dashboardStats, upcomingRenewals } from "@/server/billing/stats";
import { db } from "@/server/db";
import { idleCandidates } from "@/server/usage/manual";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const session = await currentAppSession();
  if (!session) redirect("/login");

  const [subs, stats, idle, upcoming] = await Promise.all([
    listSubscriptions(session.userId),
    dashboardStats(session.userId),
    idleCandidates(session.userId),
    upcomingRenewals(session.userId),
  ]);

  // 闲置识别（design §7.4）：连续 3 周期利用率 <10% 的 quota 映射回订阅，
  // 给出取消建议与 cancelUrl 直达链接
  const idleQuotas = await db.usageQuota.findMany({
    where: { id: { in: idle.map((c) => c.quotaId) } },
    include: {
      subscription: {
        select: {
          name: true,
          status: true,
          vendor: { select: { cancelUrl: true } },
        },
      },
    },
  });
  const idleRows = idleQuotas
    .filter((q) => q.subscription.status === "active" || q.subscription.status === "trial")
    .map((q) => ({
      subscriptionName: q.subscription.name,
      metric: q.metric,
      cancelUrl: q.subscription.vendor?.cancelUrl ?? null,
      recentUtilization: idle.find((c) => c.quotaId === q.id)?.recentUtilization ?? 0,
    }));

  return (
    <main className="shell">
      <p className="eyebrow">订阅资产管理中心</p>
      <h1>财务总览</h1>
      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-label">本月净支出</div>
          <div className="stat-value">
            {formatMoney(stats.monthNetSpend, stats.baseCurrency)}
            {stats.incomplete && (
              <span className="stat-warn"> 缺 {stats.missingProjections} 条投影</span>
            )}
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-label">年化成本</div>
          <div className="stat-value">{formatMoney(stats.annualized, stats.baseCurrency)}</div>
        </div>
        <Link href="/calendar" className="stat-card">
          <div className="stat-label">未来 {upcoming.days} 天续费</div>
          <div className="stat-value">
            {upcoming.count} <span className="stat-sub">笔</span>
          </div>
          {upcoming.nearestDate ? (
            <div className="stat-sub">
              最近 {upcoming.nearestDate} ·{" "}
              {upcoming.nearestAmounts
                .map((a) => formatMoney(a.amount, a.currency))
                .join(" + ")}
            </div>
          ) : (
            <div className="stat-sub">{upcoming.days} 天内无续费</div>
          )}
          {upcoming.trialsEnding > 0 && (
            <div className="stat-warn">{upcoming.trialsEnding} 个试用即将到期</div>
          )}
        </Link>
        <div className="stat-card">
          <div className="stat-label">预计将付</div>
          <div className="stat-value">
            {formatMoney(stats.pendingEstimate, stats.baseCurrency)}
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-label">订阅</div>
          <div className="stat-value">
            {subs.length} <span className="stat-sub">（试用 {stats.trialCount}）</span>
          </div>
        </div>
      </div>
      <p className="field-hint">
        <Link href="/analytics">查看近 12 个月趋势与分类占比 →</Link>
      </p>

      {idleRows.length > 0 && (
        <>
          <h2>可能浪费</h2>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">订阅</th>
                  <th scope="col">额度</th>
                  <th scope="col">近 3 周期利用率</th>
                  <th scope="col">建议</th>
                </tr>
              </thead>
              <tbody>
                {idleRows.map((row) => (
                  <tr key={`${row.subscriptionName}-${row.metric}`}>
                    <td>{row.subscriptionName}</td>
                    <td>{row.metric}</td>
                    <td>{(row.recentUtilization * 100).toFixed(1)}%</td>
                    <td>
                      {row.cancelUrl ? (
                        <a href={row.cancelUrl} target="_blank" rel="noreferrer">
                          去官网取消 →
                        </a>
                      ) : (
                        <span className="muted">连续低用量，考虑退订</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <h2>订阅列表</h2>
      {subs.length === 0 ? (
        <EmptyState
          title="还没有订阅"
          hint="录入第一条订阅后，这里会列出价格、周期与下次续费日。"
          action={{ href: "/subscriptions/new", label: "新建订阅" }}
        />
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">名称</th>
                <th scope="col">状态</th>
                <th scope="col">价格</th>
                <th scope="col">周期</th>
                <th scope="col">下次缴费</th>
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
        </div>
      )}
    </main>
  );
}
