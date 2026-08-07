import { redirect } from "next/navigation";

import { currentAppSession } from "@/server/auth/current-session";
import { db } from "@/server/db";

export const dynamic = "force-dynamic";

export default async function NotificationsPage() {
  const session = await currentAppSession();
  if (!session) redirect("/");

  const [rules, channels] = await Promise.all([
    db.notificationRule.findMany({
      where: { userId: session.userId },
      orderBy: { createdAt: "asc" },
    }),
    db.notificationChannel.findMany({ where: { userId: session.userId } }),
  ]);

  return (
    <main className="shell">
      <p className="eyebrow">通知中心</p>
      <h1>规则与渠道</h1>

      <h2>规则</h2>
      <table className="data-table">
        <thead>
          <tr><th>类型</th><th>配置</th><th>状态</th></tr>
        </thead>
        <tbody>
          {rules.map((rule) => (
            <tr key={rule.id}>
              <td>{rule.type}</td>
              <td><code>{JSON.stringify(rule.config)}</code></td>
              <td><span className="tag">{rule.enabled ? "启用" : "停用"}</span></td>
            </tr>
          ))}
          {rules.length === 0 && <tr><td colSpan={3} className="muted">暂无规则</td></tr>}
        </tbody>
      </table>

      <h2>渠道</h2>
      <table className="data-table">
        <thead>
          <tr><th>类型</th><th>模式</th><th>目标</th><th>状态</th></tr>
        </thead>
        <tbody>
          {channels.map((channel) => (
            <tr key={channel.id}>
              <td>{channel.type}</td>
              <td>{channel.mode}</td>
              <td>{channel.type === "webhook" ? channel.destination : "账户邮箱"}</td>
              <td><span className="tag">{channel.enabled ? "启用" : "停用"}</span></td>
            </tr>
          ))}
          {channels.length === 0 && <tr><td colSpan={4} className="muted">暂无渠道</td></tr>}
        </tbody>
      </table>
    </main>
  );
}
