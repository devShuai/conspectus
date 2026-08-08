import { redirect } from "next/navigation";

import ActionButton from "@/components/action-button";
import { ConnectProviderForm } from "@/components/settings/provider-forms";
import { currentAppSession } from "@/server/auth/current-session";
import {
  connectProviderAction,
  disconnectProviderAction,
} from "@/server/settings/actions";
import { listProviderConnections } from "@/server/usage/connections";
import { listBalanceAdapters } from "@/server/usage/providers/balance-adapters";

export const dynamic = "force-dynamic";

const STATUS_LABEL: Record<string, string> = {
  active: "正常",
  auth_failed: "凭证失效",
  degraded: "降级探测",
  disabled: "已停用",
};

export default async function ConnectionsPage() {
  const session = await currentAppSession();
  if (!session) redirect("/login");

  const [connections, providers] = await Promise.all([
    listProviderConnections(session.userId),
    Promise.resolve(
      listBalanceAdapters().map((p) => ({ id: p.id, displayName: p.displayName })),
    ),
  ]);
  const providerNames = new Map(providers.map((p) => [p.id, p.displayName]));

  return (
    <main className="shell">
      <p className="eyebrow">设置 / 服务商连接</p>
      <h1>服务商连接</h1>
      <p className="muted">
        凭据 AES-256-GCM 加密入库，只在同步任务内存中解密，不回传前端（design §7.4）。
      </p>

      <table className="data-table">
        <thead>
          <tr><th>服务商</th><th>显示名</th><th>状态</th><th>最近同步</th><th></th></tr>
        </thead>
        <tbody>
          {connections.map((conn) => (
            <tr key={conn.id}>
              <td>{providerNames.get(conn.providerId) ?? conn.providerId}</td>
              <td>{conn.displayName}</td>
              <td>
                <span className={`tag${conn.status === "active" ? "" : " warn"}`}>
                  {STATUS_LABEL[conn.status] ?? conn.status}
                </span>
                {conn.lastError && (
                  <div className="field-hint">{conn.lastError.slice(0, 80)}</div>
                )}
              </td>
              <td>{conn.lastSyncAt?.toISOString().slice(0, 16).replace("T", " ") ?? "—"}</td>
              <td>
                {conn.status !== "disabled" && (
                  <ActionButton
                    action={disconnectProviderAction}
                    fields={{ connectionId: conn.id }}
                    label="停用"
                    pendingLabel="停用中…"
                    confirm="停用后不再同步用量，对应 binding 将撤销并回退权威来源。继续？"
                    variant="danger"
                  />
                )}
              </td>
            </tr>
          ))}
          {connections.length === 0 && (
            <tr><td colSpan={5} className="muted">暂无连接</td></tr>
          )}
        </tbody>
      </table>

      <h2>添加连接</h2>
      <ConnectProviderForm action={connectProviderAction} providers={providers} />
    </main>
  );
}
