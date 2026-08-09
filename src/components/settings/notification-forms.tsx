"use client";

import { useActionState } from "react";

import type { ActionResult, SaveChannelResult } from "@/server/settings/actions";

/** 结构兼容两种 ActionResult（带不带 data 载荷）的错误渲染，与 general-forms 同款。 */
type FormState =
  | { ok: true }
  | { ok: false; error: { message: string; fieldErrors?: Record<string, string[]> } }
  | undefined;

function GlobalError({ state }: Readonly<{ state: FormState }>) {
  if (!state || state.ok) return null;
  return (
    <p className="form-error" role="alert">
      {state.error.message}
    </p>
  );
}

function FieldError({ state, name }: Readonly<{ state: FormState; name: string }>) {
  if (!state || state.ok) return null;
  const messages = state.error.fieldErrors?.[name];
  if (!messages?.length) return null;
  return (
    <p className="field-error" role="alert">
      {messages[0]}
    </p>
  );
}

type ChannelAction = (
  prev: SaveChannelResult | undefined,
  formData: FormData,
) => Promise<SaveChannelResult>;

type RuleAction = (
  prev: ActionResult | undefined,
  formData: FormData,
) => Promise<ActionResult>;

export interface ChannelEditTarget {
  id: string;
  type: "email" | "webhook";
  mode: string;
  destination: string | null;
  digestLocalTime: string | null;
}

export interface RuleEditTarget {
  id: string;
  type: string;
  config: unknown;
  subscriptionId: string | null;
}

function configList(config: unknown, key: string): string {
  const value = (config as Record<string, unknown> | null)?.[key];
  return Array.isArray(value) ? value.join(", ") : "";
}

function configValue(config: unknown, key: string): string {
  const value = (config as Record<string, unknown> | null)?.[key];
  return typeof value === "number" ? String(value) : "";
}

/** 渠道增改（#115）：webhook 保存时做带签名验证性 POST，未通过落停用。 */
export function ChannelForm({
  action,
  channel,
}: Readonly<{
  action: ChannelAction;
  channel?: ChannelEditTarget;
}>) {
  const [state, formAction, pending] = useActionState(action, undefined);
  return (
    <form className="form" action={formAction}>
      <GlobalError state={state} />
      {channel && <input type="hidden" name="channelId" value={channel.id} />}
      {channel && <input type="hidden" name="type" value={channel.type} />}
      <div className="field-row">
        {!channel && (
          <div className="field">
            <label htmlFor="channel-type">类型</label>
            <select id="channel-type" name="type" defaultValue="email">
              <option value="email">邮件（账户邮箱）</option>
              <option value="webhook">Webhook</option>
            </select>
            <FieldError state={state} name="type" />
          </div>
        )}
        <div className="field">
          <label htmlFor="channel-mode">发送模式</label>
          <select id="channel-mode" name="mode" defaultValue={channel?.mode ?? "individual"}>
            <option value="individual">逐条发送</option>
            <option value="daily_digest">每日摘要（仅邮件）</option>
          </select>
          <p className="field-hint">Webhook 强制逐条发送；每日摘要在本地 09:00 批量发出</p>
          <FieldError state={state} name="mode" />
        </div>
      </div>
      <div className="field">
        <label htmlFor="channel-destination">目标 URL（仅 Webhook）</label>
        <input
          id="channel-destination"
          name="destination"
          type="url"
          placeholder="https://example.com/hook"
          defaultValue={channel?.destination ?? ""}
        />
        <p className="field-hint">
          保存时会做一次带签名的验证性 POST；未通过则渠道保存为「停用」，修复后重新保存即可再验证
        </p>
        <FieldError state={state} name="destination" />
      </div>
      <div className="field">
        <label htmlFor="channel-digestLocalTime">摘要时刻（仅邮件每日摘要）</label>
        <input
          id="channel-digestLocalTime"
          name="digestLocalTime"
          type="time"
          defaultValue={channel?.digestLocalTime ?? ""}
        />
        <p className="field-hint">留空默认本地 09:00；时区按账户时区在入队时解释一次</p>
        <FieldError state={state} name="digestLocalTime" />
      </div>
      <div className="actions">
        <button className="button" type="submit" disabled={pending}>
          {pending ? "保存中…" : channel ? "保存修改" : "添加渠道"}
        </button>
        {state?.ok && state.data?.verified === true && (
          <span className="tag ok" role="status">已保存并通过验证</span>
        )}
        {state?.ok && state.data?.verified === false && (
          <span className="tag warn" role="alert">验证性 POST 未通过，已保存为停用</span>
        )}
        {state?.ok && state.data?.verified === null && (
          <span className="tag" role="status">已保存</span>
        )}
      </div>
    </form>
  );
}

/** 规则增改（#115）：「删除」即停用，保留投递审计（§7.6）。 */
export function RuleForm({
  action,
  subscriptions,
  rule,
}: Readonly<{
  action: RuleAction;
  subscriptions: Array<{ id: string; name: string }>;
  rule?: RuleEditTarget;
}>) {
  const [state, formAction, pending] = useActionState(action, undefined);
  return (
    <form className="form" action={formAction}>
      <GlobalError state={state} />
      {rule && <input type="hidden" name="ruleId" value={rule.id} />}
      {rule && <input type="hidden" name="type" value={rule.type} />}
      <div className="field-row">
        {!rule && (
          <div className="field">
            <label htmlFor="rule-type">类型</label>
            <select id="rule-type" name="type" defaultValue="renewal_due">
              <option value="renewal_due">续费提醒</option>
              <option value="trial_ending">试用到期</option>
              <option value="usage_threshold">用量阈值</option>
              <option value="balance_low">余额不足</option>
              <option value="collector_stale">采集器离线</option>
              <option value="price_change">涨价</option>
              <option value="connection_failed">连接失效</option>
            </select>
            <FieldError state={state} name="type" />
          </div>
        )}
        <div className="field">
          <label htmlFor="rule-subscription">作用范围</label>
          <select
            id="rule-subscription"
            name="subscriptionId"
            defaultValue={rule?.subscriptionId ?? ""}
          >
            <option value="">全部订阅（全局规则）</option>
            {subscriptions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <FieldError state={state} name="subscriptionId" />
        </div>
      </div>
      <div className="field-row">
        <div className="field">
          <label htmlFor="rule-daysBefore">提前天数（续费/试用）</label>
          <input
            id="rule-daysBefore"
            name="daysBefore"
            placeholder="7, 1"
            defaultValue={configList(rule?.config, "daysBefore")}
          />
          <FieldError state={state} name="daysBefore" />
        </div>
        <div className="field">
          <label htmlFor="rule-percent">用量百分比</label>
          <input
            id="rule-percent"
            name="percent"
            placeholder="80, 95"
            defaultValue={configList(rule?.config, "percent")}
          />
          <FieldError state={state} name="percent" />
        </div>
      </div>
      <div className="field-row">
        <div className="field">
          <label htmlFor="rule-minValue">最低余额</label>
          <input
            id="rule-minValue"
            name="minValue"
            inputMode="decimal"
            placeholder="如 20"
            defaultValue={configValue(rule?.config, "minValue")}
          />
          <FieldError state={state} name="minValue" />
        </div>
        <div className="field">
          <label htmlFor="rule-minDaysLeft">最少可用天数</label>
          <input
            id="rule-minDaysLeft"
            name="minDaysLeft"
            inputMode="numeric"
            placeholder="如 3"
            defaultValue={configValue(rule?.config, "minDaysLeft")}
          />
          <FieldError state={state} name="minDaysLeft" />
        </div>
        <div className="field">
          <label htmlFor="rule-days">离线天数（采集器）</label>
          <input
            id="rule-days"
            name="days"
            inputMode="numeric"
            placeholder="默认 3"
            defaultValue={configValue(rule?.config, "days")}
          />
          <FieldError state={state} name="days" />
        </div>
      </div>
      <p className="field-hint">
        按类型填对应项：续费/试用填提前天数；用量阈值填百分比；余额不足填最低余额或可用天数；
        采集器离线填天数；涨价与连接失效无需配置。
      </p>
      <div className="actions">
        <button className="button" type="submit" disabled={pending}>
          {pending ? "保存中…" : rule ? "保存修改" : "添加规则"}
        </button>
        {state?.ok && <span className="tag" role="status">已保存</span>}
      </div>
    </form>
  );
}
