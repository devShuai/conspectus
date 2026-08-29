import Link from "next/link";
import { redirect } from "next/navigation";

import { formatDateTime } from "@/components/datetime";
import EmptyState from "@/components/empty-state";
import { currentAppSession } from "@/server/auth/current-session";
import { spendHref } from "@/server/usage/provider-map";
import { listSubscriptions } from "@/server/billing/subscriptions";
import { db } from "@/server/db";
import {
  PROJECTION_WINDOW,
  projectBalanceDaysLeft,
  projectQuotaExhaustion,
  type SnapshotPoint,
} from "@/server/usage/insights";

export const dynamic = "force-dynamic";

/* 连接状态分级着色（#85）：active=ink 描边，disabled=muted，失败类=accent 填充 */
const CONN_TAG: Record<string, string> = {
  active: "ok",
  disabled: "off",
  auth_failed: "warn",
  degraded: "warn",
};

export default async function UsagePage() {
  const session = await currentAppSession();
  if (!session) redirect("/login");

  const [subs, quotas, connections, user] = await Promise.all([
    listSubscriptions(session.userId),
    db.usageQuota.findMany({
      where: { userId: session.userId },
      include: { bindings: true, cycleSummaries: { orderBy: { periodStart: "desc" }, take: 3 } },
      orderBy: { createdAt: "desc" },
    }),
    db.providerConnection.findMany({ where: { userId: session.userId } }),
    db.user.findUnique({
      where: { id: session.userId },
      select: { timezone: true },
    }),
  ]);
  const timezone = user?.timezone ?? "UTC";

  // 每个 quota 取最近 N 条快照做外推（design §7.4 用量洞察）；
  // quota 类只取本周期内的点，周期重置前的读数会污染斜率
  const now = new Date();
  const projections = new Map(
    await Promise.all(
      quotas.map(async (quota) => {
        const snapshots = await db.usageSnapshot.findMany({
          where: {
            quotaId: quota.id,
            ...(quota.kind === "quota" && quota.periodStart
              ? { capturedAt: { gte: quota.periodStart, lte: now } }
              : { capturedAt: { lte: now } }),
          },
          orderBy: { capturedAt: "desc" },
          take: PROJECTION_WINDOW,
          select: { capturedAt: true, value: true },
        });
        const points: SnapshotPoint[] = snapshots.map((s) => ({
          capturedAt: s.capturedAt,
          value: Number(s.value),
        }));
        if (quota.kind === "quota") {
          const projection = projectQuotaExhaustion(points, {
            used: Number(quota.usedValue ?? 0),
            limit: Number(quota.limitValue ?? 0),
            periodEnd: quota.periodEnd,
            now,
          });
          return [quota.id, projection ? quotaText(projection) : null] as const;
        }
        if (quota.kind === "balance") {
          const daysLeft = projectBalanceDaysLeft(points, {
            remaining: Number(quota.remainingValue ?? 0),
          });
          return [
            quota.id,
            daysLeft !== null ? `按当前速度约可用 ${Math.ceil(daysLeft)} 天` : null,
          ] as const;
        }
        return [quota.id, null] as const;
      }),
    ),
  );

  const subName = new Map(subs.map((s) => [s.id, s.name]));

  return (
    <main className="shell">
      <p className="eyebrow">用量中心</p>
      <h1>用量额度</h1>

      {quotas.length === 0 && (
        <EmptyState
          title="暂无用量卡"
          hint="配置本地 CLI、连接服务端 Provider，或创建一张手动额度。"
          action={{ href: "/settings/usage", label: "配置用量来源" }}
        />
      )}

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
              {/* 穿透（#143）：跳到同一来源、同一周期窗口的消耗明细。
                  映射缺失时不显示入口，而不是跳进一个空筛选。 */}
              {(() => {
                const href = spendHref(auth?.collectorId ?? null, {
                  start: quota.periodStart,
                  end: quota.periodEnd,
                });
                return href ? (
                  <div className="usage-meta">
                    <Link href={href}>查看本周期消耗明细 →</Link>
                  </div>
                ) : null;
              })()}
              {projections.get(quota.id) && (
                <div className="usage-meta">{projections.get(quota.id)}</div>
              )}
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
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr><th scope="col">服务商</th><th scope="col">状态</th><th scope="col">上次同步</th><th scope="col">下次同步</th><th scope="col">错误</th></tr>
          </thead>
          <tbody>
            {connections.map((conn) => (
              <tr key={conn.id}>
                <td>{conn.displayName}</td>
                <td><span className={`tag ${CONN_TAG[conn.status] ?? ""}`.trim()}>{conn.status}</span></td>
                <td className="date">{conn.lastSyncAt ? formatDateTime(conn.lastSyncAt, timezone) : "—"}</td>
                <td className="date">{conn.nextSyncAt ? formatDateTime(conn.nextSyncAt, timezone) : "—"}</td>
                <td>{conn.lastError ?? "—"}</td>
              </tr>
            ))}
            {connections.length === 0 && (
              <tr><td colSpan={5} className="muted">未连接任何服务商</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </main>
  );
}

/** design §7.4：quota 给「预计周期结束前 X 天用完」，本周期用不完则如实说明。 */
function quotaText(projection: {
  daysUntilExhausted: number;
  daysBeforePeriodEnd: number | null;
}): string {
  if (projection.daysBeforePeriodEnd !== null) {
    return `预计周期结束前 ${Math.ceil(projection.daysBeforePeriodEnd)} 天用完`;
  }
  return "按当前速度本周期用不完";
}
