import Link from "next/link";
import { redirect } from "next/navigation";

import EmptyState from "@/components/empty-state";
import { formatDateTime } from "@/components/datetime";
import { currentAppSession } from "@/server/auth/current-session";
import { db } from "@/server/db";
import {
  loadLedgerView,
  type LedgerBreakdownRow,
} from "@/server/usage/ledger-query";

export const dynamic = "force-dynamic";

const NUMBER = new Intl.NumberFormat("zh-CN");
const USD = new Intl.NumberFormat("zh-CN", { style: "currency", currency: "USD" });

export default async function SpendPage({
  searchParams,
}: {
  searchParams: Promise<{ provider?: string; from?: string; to?: string }>;
}) {
  const session = await currentAppSession();
  if (!session) redirect("/login");

  const { provider, from, to } = await searchParams;
  const user = await db.user.findUnique({
    where: { id: session.userId },
    select: { timezone: true },
  });
  const timezone = user?.timezone ?? "UTC";
  const view = await loadLedgerView(session.userId, timezone, { provider, from, to });
  const filtered = Boolean(provider || from || to);

  return (
    <main className="shell">
      <p className="eyebrow">消耗</p>
      <h1>Token 消耗</h1>
      <p className="muted">
        按天汇总的实际消耗，与「用量」的额度进度相互独立。
        {/* 这层关系必须写出来：两个数字并排出现，用户会默认它们该对得上。
            本地 token 求和还原不了服务端按未公开规则加权算出的配额百分比（#136）。 */}
        <strong>它不是额度百分比的分解</strong>
        ——同一时间窗里消耗了什么，与「离限额还有多远」是两个问题。
      </p>

      {filtered && (
        <p className="field-hint">
          已筛选{provider ? `：${provider}` : ""}
          {from && to ? `　${from} → ${to}` : ""}
          <Link href="/spend">　清除筛选</Link>
        </p>
      )}

      {view.totals.apiCalls === 0 ? (
        <EmptyState
          title="暂无消耗数据"
          hint="安装本地采集器并完成一次上报后，这里会按天汇总实际消耗。"
          action={{ href: "/settings/devices", label: "查看采集设备" }}
        />
      ) : (
        <>
          <div className="stats-grid">
            <Stat label="成本" value={USD.format(view.totals.costUsd)} />
            <Stat label="Token" value={NUMBER.format(view.totals.tokens)} />
            <Stat label="调用次数" value={NUMBER.format(view.totals.apiCalls)} />
            <Stat label="会话数" value={NUMBER.format(view.totals.sessions)} />
          </div>
          {view.lastCapturedAt && (
            <p className="field-hint">
              最近上报：{formatDateTime(view.lastCapturedAt, timezone)}
            </p>
          )}

          <Breakdown
            title="按来源"
            rows={view.byProvider}
            // 穿透：点来源即筛选该来源；用量页反向跳进来时也用同一个参数
            hrefFor={(key) => `/spend?provider=${encodeURIComponent(key)}`}
          />
          <Breakdown title="按模型" rows={view.byModel} />
          <Breakdown title="按项目" rows={view.byProject} />
        </>
      )}
    </main>
  );
}

function Stat({ label, value }: Readonly<{ label: string; value: string }>) {
  return (
    <div className="stat-card">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
    </div>
  );
}

function Breakdown({
  title,
  rows,
  hrefFor,
}: Readonly<{
  title: string;
  rows: LedgerBreakdownRow[];
  hrefFor?: (key: string) => string;
}>) {
  if (rows.length === 0) return null;
  return (
    <>
      <h2>{title}</h2>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">名称</th>
              <th scope="col">成本</th>
              <th scope="col">占比</th>
              <th scope="col">Token</th>
              <th scope="col">调用</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key}>
                <td>{hrefFor ? <Link href={hrefFor(row.key)}>{row.key}</Link> : row.key}</td>
                <td className="num">{USD.format(row.costUsd)}</td>
                <td className="num">{row.sharePct.toFixed(1)}%</td>
                <td className="num">{NUMBER.format(row.tokens)}</td>
                <td className="num">{NUMBER.format(row.apiCalls)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
