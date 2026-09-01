import Link from "next/link";
import { redirect } from "next/navigation";

import EmptyState from "@/components/empty-state";
import { formatDateTime } from "@/components/datetime";
import { currentAppSession } from "@/server/auth/current-session";
import { db } from "@/server/db";
import {
  loadLedgerView,
  type LedgerBreakdownRow,
  type LedgerToolRow,
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
            {view.sessionCount > 0 && (
              <Stat label="会话数" value={NUMBER.format(view.sessionCount)} />
            )}
            {view.totals.reasoningTokens > 0 && (
              <Stat
                label="推理 Token"
                value={NUMBER.format(view.totals.reasoningTokens)}
              />
            )}
            {view.totals.savedUsd > 0 && (
              <Stat label="已节省" value={USD.format(view.totals.savedUsd)} />
            )}
          </div>
          {view.totals.reasoningTokens > 0 && (
            <p className="field-hint">
              {/* 不能默默加进总数：不同来源语义不一样，见 ledger-query.ts 的注释 */}
              推理 Token 未计入上面的 Token 总数——codex、opencode 把它算作 output
              的一部分，grok 则是独立计量，合并会把前者算重。
            </p>
          )}
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
          <Breakdown
            title="按任务类型"
            caption="codeburn 依据会话内容归类：钱花在写代码、调试，还是来回对话上。"
            rows={view.byCategory}
          />
          <Breakdown title="按模型" rows={view.byModel} />
          <Breakdown title="按项目" rows={view.byProject} />

          {view.sessions.length > 0 && (
            <>
              <h2>按会话</h2>
              <p className="muted">成本最高的会话在前，最多列 100 条。</p>
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th scope="col">项目</th>
                      <th scope="col">来源</th>
                      <th scope="col">开始</th>
                      <th scope="col">成本</th>
                      <th scope="col">调用</th>
                      <th scope="col">轮次</th>
                    </tr>
                  </thead>
                  <tbody>
                    {view.sessions.map((row) => (
                      <tr key={row.sessionId}>
                        <td>{row.projectKey || "未标注"}</td>
                        <td>{row.provider || "—"}</td>
                        <td>{formatDateTime(row.startedAt, timezone)}</td>
                        <td className="num">{USD.format(row.costUsd)}</td>
                        <td className="num">{NUMBER.format(row.apiCalls)}</td>
                        <td className="num">{NUMBER.format(row.turns)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {view.modelQuality.length > 0 && (
            <>
              <h2>按模型的效率</h2>
              <p className="muted">
                贵的模型是否真的更省事：一次成型率越高、每次编辑的重试越少，
                同样的活就越便宜。
                {view.snapshotUnfiltered && <SnapshotNote />}
              </p>
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th scope="col">模型</th>
                      <th scope="col">成本</th>
                      <th scope="col">占比</th>
                      <th scope="col">编辑轮次</th>
                      <th scope="col">一次成型</th>
                      <th scope="col">每次编辑重试</th>
                      <th scope="col">每次编辑成本</th>
                    </tr>
                  </thead>
                  <tbody>
                    {view.modelQuality.map((row) => (
                      <tr key={row.model}>
                        <td>{row.model}</td>
                        <td className="num">{USD.format(row.costUsd)}</td>
                        <td className="num">{row.sharePct.toFixed(1)}%</td>
                        <td className="num">{NUMBER.format(row.editTurns)}</td>
                        <td className="num">{row.oneShotRatePct.toFixed(1)}%</td>
                        <td className="num">{row.retriesPerEdit.toFixed(1)}</td>
                        <td className="num">{USD.format(row.costPerEditUsd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          <ToolTable
            title="按工具"
            rows={view.tools}
            note={view.snapshotUnfiltered}
          />
          <ToolTable title="按 MCP 服务" rows={view.mcp} note={view.snapshotUnfiltered} />
        </>
      )}
    </main>
  );
}

/**
 * 快照类板块不跟随筛选。codeburn 只按 30 天窗口给这些合计，源头就没有 provider
 * 与日期维度 —— 不写出来的话，用户点了筛选看到数字没变，会以为页面坏了。
 */
function SnapshotNote() {
  return (
    <>
      {" "}
      <strong>本块不受上方筛选影响</strong>
      ：来源只提供 30 天窗口的合计，没有来源与日期维度。
    </>
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

function ToolTable({
  title,
  rows,
  note,
}: Readonly<{ title: string; rows: LedgerToolRow[]; note: boolean }>) {
  if (rows.length === 0) return null;
  return (
    <>
      <h2>{title}</h2>
      {note && (
        <p className="muted">
          <SnapshotNote />
        </p>
      )}
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">名称</th>
              <th scope="col">调用</th>
              <th scope="col">占比</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.name}>
                <td>{row.name}</td>
                <td className="num">{NUMBER.format(row.calls)}</td>
                <td className="num">{row.sharePct.toFixed(1)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Breakdown({
  title,
  caption,
  rows,
  hrefFor,
}: Readonly<{
  title: string;
  caption?: string;
  rows: LedgerBreakdownRow[];
  hrefFor?: (key: string) => string;
}>) {
  if (rows.length === 0) return null;
  const showReasoning = rows.some((row) => row.reasoningTokens > 0);
  return (
    <>
      <h2>{title}</h2>
      {caption && <p className="muted">{caption}</p>}
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">名称</th>
              <th scope="col">成本</th>
              <th scope="col">占比</th>
              <th scope="col">Token</th>
              {showReasoning && <th scope="col">推理</th>}
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
                {showReasoning && (
                  <td className="num">{NUMBER.format(row.reasoningTokens)}</td>
                )}
                <td className="num">{NUMBER.format(row.apiCalls)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
