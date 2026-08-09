import { redirect } from "next/navigation";

import ActionButton from "@/components/action-button";
import { ChannelForm, RuleForm } from "@/components/settings/notification-forms";
import { currentAppSession } from "@/server/auth/current-session";
import { db } from "@/server/db";
import { emailGateState, readWebhookSecret, type EmailGateState } from "@/server/notify/manage";
import {
  rotateNotificationChannelSecret,
  saveNotificationChannel,
  saveNotificationRule,
  seedNotificationRulesAction,
  setNotificationChannelEnabled,
} from "@/server/settings/actions";

export const dynamic = "force-dynamic";

/** @db.Time 载体（1970-01-01 UTC）→ "HH:MM"。 */
function digestTimeLabel(value: Date | null): string | null {
  if (!value) return null;
  const hh = String(value.getUTCHours()).padStart(2, "0");
  const mm = String(value.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

const RULE_TYPE_LABEL: Record<string, string> = {
  renewal_due: "续费提醒",
  trial_ending: "试用到期",
  usage_threshold: "用量阈值",
  balance_low: "余额不足",
  collector_stale: "采集器离线",
  price_change: "涨价",
  connection_failed: "连接失效",
};

const GATE_TAG: Record<Exclude<EmailGateState, "verified">, { label: string; className: string }> = {
  no_email: { label: "未设置邮箱", className: "warn" },
  local_unverified: { label: "邮箱未验证", className: "warn" },
  certus_unverified: { label: "认证中心未验证", className: "warn" },
};

const GATE_BANNER: Record<Exclude<EmailGateState, "verified" | "no_email">, string> = {
  local_unverified: "请完成本地邮箱验证；验证后新提醒即可投递，期间的提醒不会补发。",
  certus_unverified: "请到认证中心完成邮箱验证；验证后新提醒即可投递，期间的提醒不会补发。",
};

export default async function NotificationsSettingsPage() {
  const session = await currentAppSession();
  if (!session) redirect("/login");

  const [rules, channels, user, subscriptions] = await Promise.all([
    db.notificationRule.findMany({
      where: { userId: session.userId },
      orderBy: { createdAt: "asc" },
    }),
    db.notificationChannel.findMany({
      where: { userId: session.userId },
      orderBy: { createdAt: "asc" },
    }),
    db.user.findUnique({
      where: { id: session.userId },
      select: {
        email: true,
        emailVerifiedAt: true,
        passwordHash: true,
      },
    }),
    db.subscription.findMany({
      where: { userId: session.userId },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
  ]);

  const gate = user ? emailGateState(user) : "no_email";
  const hasEnabledEmail = channels.some((c) => c.type === "email" && c.enabled);
  const subscriptionNames = new Map(subscriptions.map((s) => [s.id, s.name]));

  return (
    <main className="shell">
      <p className="eyebrow">设置 / 通知</p>
      <h1>规则与渠道</h1>

      {hasEnabledEmail && gate !== "verified" && gate !== "no_email" && (
        <p className="form-error" role="alert">
          邮件渠道当前不可投递：账户邮箱（{user?.email ?? "未设置"}）未完成验证。
          {GATE_BANNER[gate]}
        </p>
      )}

      <h2>渠道</h2>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr><th scope="col">类型</th><th scope="col">模式</th><th scope="col">目标</th><th scope="col">状态</th><th></th></tr>
          </thead>
          <tbody>
            {channels.map((channel) => (
              <tr key={channel.id}>
                <td>{channel.type === "email" ? "邮件" : "Webhook"}</td>
                <td>
                  {channel.mode === "daily_digest"
                    ? `每日摘要 ${digestTimeLabel(channel.digestLocalTime) ?? "09:00"}`
                    : "逐条发送"}
                </td>
                <td>
                  {channel.type === "webhook" ? (
                    <>
                      <code>{channel.destination}</code>
                      <br />
                      <span className="muted">
                        签名密钥 <code>{readWebhookSecret(channel.secretCipher) ?? "（不可用）"}</code>
                      </span>
                    </>
                  ) : (
                    <>
                      账户邮箱（{user?.email ?? "未设置"}）
                      {gate !== "verified" && (
                        <span className={`tag ${GATE_TAG[gate].className}`}>{GATE_TAG[gate].label}</span>
                      )}
                    </>
                  )}
                </td>
                <td>
                  <span className={`tag ${channel.enabled ? "ok" : "off"}`}>
                    {channel.enabled ? "启用" : "停用"}
                  </span>
                </td>
                <td>
                  <ActionButton
                    action={setNotificationChannelEnabled}
                    fields={{
                      channelId: channel.id,
                      enabled: channel.enabled ? "false" : "true",
                    }}
                    label={channel.enabled ? "停用" : "启用"}
                    pendingLabel={!channel.enabled && channel.type === "webhook" ? "验证中…" : "处理中…"}
                  />
                  {channel.type === "webhook" && (
                    <ActionButton
                      action={rotateNotificationChannelSecret}
                      fields={{ channelId: channel.id }}
                      label="轮换密钥"
                      pendingLabel="轮换中…"
                      confirm="轮换后旧签名立即失效，确定轮换？"
                    />
                  )}
                  <details>
                    <summary>编辑</summary>
                    <ChannelForm
                      action={saveNotificationChannel}
                      channel={{
                        id: channel.id,
                        type: channel.type,
                        mode: channel.mode,
                        destination: channel.destination,
                        digestLocalTime: digestTimeLabel(channel.digestLocalTime),
                      }}
                    />
                  </details>
                </td>
              </tr>
            ))}
            {channels.length === 0 && <tr><td colSpan={5} className="muted">暂无渠道</td></tr>}
          </tbody>
        </table>
      </div>
      <details>
        <summary>添加渠道</summary>
        <ChannelForm action={saveNotificationChannel} />
      </details>

      <h2>规则</h2>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr><th scope="col">类型</th><th scope="col">配置</th><th scope="col">范围</th><th scope="col">状态</th><th></th></tr>
          </thead>
          <tbody>
            {rules.map((rule) => (
              <tr key={rule.id}>
                <td>{RULE_TYPE_LABEL[rule.type] ?? rule.type}</td>
                <td><code>{JSON.stringify(rule.config)}</code></td>
                <td>{rule.subscriptionId ? subscriptionNames.get(rule.subscriptionId) ?? "（已删除订阅）" : "全局"}</td>
                <td><span className={`tag ${rule.enabled ? "ok" : "off"}`}>{rule.enabled ? "启用" : "停用"}</span></td>
                <td>
                  <ActionButton
                    action={saveNotificationRule}
                    fields={{
                      ruleId: rule.id,
                      type: rule.type,
                      enabled: rule.enabled ? "false" : "true",
                    }}
                    label={rule.enabled ? "停用" : "启用"}
                  />
                  <details>
                    <summary>编辑</summary>
                    <RuleForm
                      action={saveNotificationRule}
                      subscriptions={subscriptions}
                      rule={{
                        id: rule.id,
                        type: rule.type,
                        config: rule.config,
                        subscriptionId: rule.subscriptionId,
                      }}
                    />
                  </details>
                </td>
              </tr>
            ))}
            {rules.length === 0 && <tr><td colSpan={5} className="muted">暂无规则</td></tr>}
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
      <details>
        <summary>添加规则</summary>
        <RuleForm action={saveNotificationRule} subscriptions={subscriptions} />
      </details>
    </main>
  );
}
