import Link from "next/link";
import { redirect } from "next/navigation";

import ActionButton from "@/components/action-button";
import EmptyState from "@/components/empty-state";
import {
  LocalCollectorSetupForm,
  ManualQuotaForm,
  ManualUsageUpdateForm,
} from "@/components/settings/usage-forms";
import { currentAppSession } from "@/server/auth/current-session";
import { formatDateTime } from "@/components/datetime";
import { formatMoney } from "@/components/money";
import { db } from "@/server/db";
import { COLLECTOR_OPTIONS } from "@/server/usage/bindings";
import {
  createLocalCollectorSetupAction,
  createManualQuotaAction,
  deleteUsageMetricAction,
  switchUsageAuthorityAction,
  updateManualUsageAction,
} from "@/server/settings/actions";

export const dynamic = "force-dynamic";

const SOURCE_LABEL: Record<string, string> = {
  local_agent: "本地 CLI",
  provider: "服务端连接",
  manual: "手动",
};

export default async function UsageEntryPage() {
  const session = await currentAppSession();
  if (!session) redirect("/login");

  const [subscriptions, quotas, devices, user] = await Promise.all([
    db.subscription.findMany({
      where: { userId: session.userId },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
    db.usageQuota.findMany({
      where: { userId: session.userId },
      orderBy: { createdAt: "desc" },
      include: {
        subscription: { select: { name: true } },
        bindings: {
          orderBy: { createdAt: "asc" },
          include: {
            snapshots: {
              orderBy: [{ capturedAt: "desc" }, { id: "desc" }],
              take: 1,
              select: { capturedAt: true },
            },
          },
        },
      },
    }),
    db.collectorDevice.findMany({
      where: { userId: session.userId, revokedAt: null },
      orderBy: { lastSeenAt: "desc" },
      select: { id: true, lastSeenAt: true },
    }),
    db.user.findUnique({
      where: { id: session.userId },
      select: { timezone: true },
    }),
  ]);
  const timezone = user?.timezone ?? "UTC";
  const localBindings = quotas.flatMap((quota) => quota.bindings.filter((binding) => binding.source === "local_agent" && binding.status === "active"));
  const awaitingFirstSync = localBindings.filter((binding) => binding.snapshots.length === 0).length;

  const collectors = COLLECTOR_OPTIONS.map((collector) => ({
    id: collector.id,
    displayName: collector.displayName,
    metricPrefix: collector.metricPrefix,
    description: collector.description,
    metrics: collector.metrics.map((metric) => ({
      id: metric.id,
      label: metric.label,
      kind: metric.kind,
      unit: metric.unit,
    })),
  }));

  return (
    <main className="shell">
      <p className="eyebrow">设置 / 用量来源</p>
      <h1>把用量接进来</h1>
      <p className="summary">
        本地 CLI 采集 Codex、Claude 与 Kimi Code；服务端连接负责 MiniMax 等 Provider；手动录入始终作为兜底。
      </p>

      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-label">本地采集来源</div>
          <div className="stat-value">{localBindings.length}</div>
          <div className="stat-sub">来自 {COLLECTOR_OPTIONS.length} 种受支持产品</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">等待首次同步</div>
          <div className="stat-value">{awaitingFirstSync}</div>
          <div className="stat-sub">运行一次 collect run 即可验证</div>
        </div>
        <Link href="/settings/devices" className="stat-card">
          <div className="stat-label">已授权设备</div>
          <div className="stat-value">{devices.length}</div>
          <div className="stat-sub">查看设备状态与撤销权限 →</div>
        </Link>
      </div>

      <section className="source-section" aria-labelledby="local-setup-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">推荐</p>
            <h2 id="local-setup-title">添加本地采集</h2>
          </div>
          <span className="tag ok">凭据不离开本机</span>
        </div>
        <p className="muted">
          选择订阅和本机已经登录的产品。系统会按官方窗口创建额度与 Binding，不再要求手填 metric。
        </p>
        {subscriptions.length === 0 ? (
          <EmptyState
            title="先创建一条订阅"
            hint="用量必须归属到订阅，创建后再回来选择采集指标。"
            action={{ href: "/subscriptions/new", label: "新建订阅" }}
          />
        ) : (
          <LocalCollectorSetupForm
            action={createLocalCollectorSetupAction}
            subscriptions={subscriptions}
            collectors={collectors}
          />
        )}
      </section>

      <section className="source-section" aria-labelledby="cli-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">下一步</p>
            <h2 id="cli-title">安装并运行 CLI</h2>
          </div>
          <Link href="/settings/devices" className="button secondary">采集设备</Link>
        </div>
        <ol className="setup-steps">
          <li><span>1</span><div><strong>安装</strong><code>npm config set @devshuai:registry https://nexus.devshuai.com/repository/npm-hosted/</code><code>npm install -g @devshuai/conspectus-collect</code></div></li>
          <li><span>2</span><div><strong>连接当前站点</strong><code>conspectus-collect configure</code></div></li>
          <li><span>3</span><div><strong>授权设备</strong><code>conspectus-collect login</code></div></li>
          <li><span>4</span><div><strong>验证首轮采集</strong><code>conspectus-collect run</code></div></li>
        </ol>
        <p className="field-hint">
          正常结果的 <code>manifestBindings</code> 大于 0，且 <code>accepted</code> 大于 0。若仍显示 no_local_bindings，请先在上方创建来源。
        </p>
        <p className="field-hint">
          产品应用无需保持运行。Kimi Code 会复用并刷新现有 OAuth 凭据；Claude 在 Windows 上不能仅凭桌面端登录采集，需先运行 <code>claude setup-token</code>，再设置 <code>CLAUDE_CODE_OAUTH_TOKEN</code>。
        </p>
      </section>

      <section aria-labelledby="configured-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">当前配置</p>
            <h2 id="configured-title">额度与来源</h2>
          </div>
          <Link href="/settings/connections" className="button secondary">服务端连接</Link>
        </div>
        {quotas.length === 0 ? (
          <EmptyState title="还没有用量来源" hint="在上方选择本机产品，或连接服务端 Provider。" />
        ) : (
          <div className="usage-grid source-grid">
            {quotas.map((quota) => {
              const manualBinding = quota.bindings.find((binding) => binding.source === "manual" && binding.status === "active");
              return (
                <article key={quota.id} className="usage-card source-card">
                  <div className="usage-card-head">
                    <span className="usage-metric">{quota.subscription.name} · {quota.metric}</span>
                    <div className="metric-card-actions">
                      <span className="tag">{quota.kind}</span>
                      <ActionButton
                        action={deleteUsageMetricAction}
                        fields={{ quotaId: quota.id }}
                        label="删除指标"
                        pendingLabel="删除中…"
                        variant="danger"
                        confirm={`删除指标「${quota.metric}」？它的全部来源、历史读数和周期汇总也会永久删除，但不会删除订阅。`}
                      />
                    </div>
                  </div>
                  <div className="source-value">
                    {quota.kind === "balance"
                      ? `剩余 ${quota.remainingValue ? formatMoney(Number(quota.remainingValue), quota.unit) : "—"}`
                      : `已用 ${quota.usedValue?.toString() ?? "—"}${quota.limitValue ? ` / ${quota.limitValue.toString()}` : ""} ${quota.unit}`}
                  </div>
                  <p className="usage-meta">
                    当前值 {quota.valueCapturedAt ? `采集于 ${formatDateTime(quota.valueCapturedAt, timezone)}` : "等待首次采集"}
                  </p>
                  <div className="binding-list" aria-label="可用来源">
                    {quota.bindings.map((binding) => {
                      const authoritative = binding.id === quota.authoritativeBindingId;
                      const lastSnapshot = binding.snapshots[0]?.capturedAt;
                      return (
                        <div key={binding.id} className={`binding-row${authoritative ? " authoritative" : ""}`}>
                          <div>
                            <strong>{SOURCE_LABEL[binding.source] ?? binding.source}</strong>
                            <small>
                              {binding.sourceKey}
                              {lastSnapshot ? ` · ${formatDateTime(lastSnapshot, timezone)}` : " · 待首次同步"}
                            </small>
                          </div>
                          {binding.status === "revoked" ? (
                            <span className="tag off">已撤销</span>
                          ) : authoritative ? (
                            <span className="tag ok">当前来源</span>
                          ) : (
                            <ActionButton
                              action={switchUsageAuthorityAction}
                              fields={{ quotaId: quota.id, bindingId: binding.id }}
                              label="改用此来源"
                              pendingLabel="切换中…"
                              confirm={`将「${quota.metric}」改用 ${SOURCE_LABEL[binding.source] ?? binding.source}？当前值会从该来源的最近快照重建。`}
                            />
                          )}
                        </div>
                      );
                    })}
                  </div>
                  {manualBinding && (
                    <details>
                      <summary>更新手动读数</summary>
                      <ManualUsageUpdateForm action={updateManualUsageAction} quotaId={quota.id} kind={quota.kind} />
                    </details>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </section>

      <section className="manual-section" aria-labelledby="manual-title">
        <details>
          <summary id="manual-title">没有可采集来源？创建手动额度</summary>
          <p className="muted">手动录入适合没有 CLI、没有服务端 API 的套餐。创建后可随时更新读数。</p>
          {subscriptions.length === 0 ? (
            <p className="muted">先创建一条订阅，才能为它建额度。</p>
          ) : (
            <ManualQuotaForm action={createManualQuotaAction} subscriptions={subscriptions} />
          )}
        </details>
      </section>
    </main>
  );
}
