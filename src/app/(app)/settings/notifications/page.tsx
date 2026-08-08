import { redirect } from "next/navigation";

import ActionButton from "@/components/action-button";
import { currentAppSession } from "@/server/auth/current-session";
import { db } from "@/server/db";
import { seedNotificationRulesAction } from "@/server/settings/actions";

export const dynamic = "force-dynamic";

export default async function NotificationsSettingsPage() {
  const session = await currentAppSession();
  if (!session) redirect("/login");

  const [rules, channels, user] = await Promise.all([
    db.notificationRule.findMany({
      where: { userId: session.userId },
      orderBy: { createdAt: "asc" },
    }),
    db.notificationChannel.findMany({ where: { userId: session.userId } }),
    db.user.findUnique({
      where: { id: session.userId },
      select: { email: true, emailVerifiedAt: true },
    }),
  ]);

  const emailBlocked = channels.some((c) => c.type === "email" && c.enabled) &&
    !user?.emailVerifiedAt;

  return (
    <main className="shell">
      <p className="eyebrow">设置 / 通知</p>
      <h1>规则与渠道</h1>

      {emailBlocked && (
        <p className="form-error" role="alert">
          邮件渠道当前不可投递：账户邮箱（{user?.email ?? "未设置"}）未完成验证。
          请在认证中心完成邮箱验证；验证后约一个小时内自动恢复投递，期间的提醒不会补发。
        </p>
      )}

      <h2>规则</h2>
      <div className="table-wrap">
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
      </div>
      {rules.length === 0 && (
        <ActionButton
          action={seedNotificationRulesAction}
          fields={{}}
          label="生成默认规则（续费 7/1 天、试用 3/1 天、用量 80/95）"
          pendingLabel="生成中…"
        />
      )}

      <h2>渠道</h2>
      <div className="table-wrap">
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
                <td>
                  <span className={`tag${channel.enabled ? "" : " warn"}`}>
                    {channel.enabled ? "启用" : "停用"}
                  </span>
                  {channel.type === "email" && channel.enabled && !user?.emailVerifiedAt && (
                    <span className="tag warn">未验证不投递</span>
                  )}
                </td>
              </tr>
            ))}
            {channels.length === 0 && <tr><td colSpan={4} className="muted">暂无渠道</td></tr>}
          </tbody>
        </table>
      </div>
    </main>
  );
}
