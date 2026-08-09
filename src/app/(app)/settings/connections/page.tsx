import { redirect } from "next/navigation";

import ActionButton from "@/components/action-button";
import EmptyState from "@/components/empty-state";
import { ConnectProviderForm } from "@/components/settings/provider-forms";
import { formatDateTime } from "@/components/datetime";
import { currentAppSession } from "@/server/auth/current-session";
import { db } from "@/server/db";
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

  const [connections, providers, subscriptions, user] = await Promise.all([
    listProviderConnections(session.userId),
    Promise.resolve(
      listBalanceAdapters().map((p) => ({ id: p.id, displayName: p.displayName })),
    ),
    db.subscription.findMany({
      where: { userId: session.userId },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
    db.user.findUnique({
      where: { id: session.userId },
      select: { timezone: true },
    }),
  ]);
  const timezone = user?.timezone ?? "UTC";
  const providerNames = new Map(providers.map((p) => [p.id, p.displayName]));

  return (
    <main className="shell">
      <p className="eyebrow">设置 / 服务商连接</p>
      <h1>服务商连接</h1>
      <p className="muted">
        凭据 AES-256-GCM 加密入库，只在同步任务内存中解密，不回传前端（design §7.4）。
      </p>

      {connections.length === 0 ? (
        <EmptyState
          title="暂无连接"
          hint="连接服务商后，用量与余额会自动同步，不用再手动录入。"
          action={{ href: "/settings/connections#add", label: "添加连接" }}
        />
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr><th scope="col">服务商</th><th scope="col">显示名</th><th scope="col">状态</th><th scope="col">最近同步</th><th></th></tr>
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
                  <td className="date">{conn.lastSyncAt ? formatDateTime(conn.lastSyncAt, timezone) : "—"}</td>
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
            </tbody>
          </table>
        </div>
      )}

      <h2 id="add">添加连接</h2>
      {subscriptions.length === 0 ? (
        <p className="muted">先创建一条订阅，连接才能归属到它。</p>
      ) : (
        <ConnectProviderForm
          action={connectProviderAction}
          providers={providers}
          subscriptions={subscriptions}
        />
      )}
    </main>
  );
}
