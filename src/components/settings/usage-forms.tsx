"use client";

import { useActionState, useState } from "react";

import type { ActionResult } from "@/server/settings/actions";

import { FieldError, GlobalError } from "./general-forms";

type Action = (
  prev: ActionResult | undefined,
  formData: FormData,
) => Promise<ActionResult>;

export interface SubscriptionOption {
  id: string;
  name: string;
}

export function ManualQuotaForm({
  action,
  subscriptions,
}: Readonly<{ action: Action; subscriptions: SubscriptionOption[] }>) {
  const [state, formAction, pending] = useActionState(action, undefined);
  return (
    <form className="form" action={formAction}>
      <GlobalError state={state} />
      <div className="field">
        <label htmlFor="subscriptionId">订阅</label>
        <select id="subscriptionId" name="subscriptionId" required>
          <option value="">请选择</option>
          {subscriptions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <FieldError state={state} name="subscriptionId" />
      </div>
      <div className="field-row">
        <div className="field">
          <label htmlFor="kind">计量模型</label>
          <select id="kind" name="kind" defaultValue="quota">
            <option value="quota">quota 配额（周期重置，有上限）</option>
            <option value="balance">balance 余额（越用越少）</option>
            <option value="counter">counter 计数（只累计）</option>
          </select>
          <FieldError state={state} name="kind" />
        </div>
        <div className="field">
          <label htmlFor="resetCycle">重置周期</label>
          <select id="resetCycle" name="resetCycle" defaultValue="monthly">
            <option value="daily">daily</option>
            <option value="weekly">weekly</option>
            <option value="monthly">monthly</option>
            <option value="billing_cycle">billing_cycle</option>
            <option value="never">never</option>
          </select>
          <FieldError state={state} name="resetCycle" />
        </div>
      </div>
      <div className="field-row">
        <div className="field">
          <label htmlFor="metric">指标</label>
          <input id="metric" name="metric" placeholder="requests / tokens / credit" required />
          <FieldError state={state} name="metric" />
        </div>
        <div className="field">
          <label htmlFor="unit">单位</label>
          <input id="unit" name="unit" placeholder="次 / USD" required />
          <FieldError state={state} name="unit" />
        </div>
      </div>
      <div className="field-row">
        <div className="field">
          <label htmlFor="limitValue">上限（quota 必填）</label>
          <input id="limitValue" name="limitValue" inputMode="decimal" />
          <FieldError state={state} name="limitValue" />
        </div>
        <div className="field">
          <label htmlFor="usedValue">已用</label>
          <input id="usedValue" name="usedValue" inputMode="decimal" />
          <FieldError state={state} name="usedValue" />
        </div>
        <div className="field">
          <label htmlFor="remainingValue">剩余（balance 必填）</label>
          <input id="remainingValue" name="remainingValue" inputMode="decimal" />
          <FieldError state={state} name="remainingValue" />
        </div>
      </div>
      <div className="actions">
        <button className="button" type="submit" disabled={pending}>
          {pending ? "创建中…" : "创建额度"}
        </button>
        {state?.ok && <span className="tag" role="status">已创建</span>}
      </div>
    </form>
  );
}

export interface CollectorOption {
  id: string;
  displayName: string;
  metricPrefix: string;
}

export interface CollectorCatalogOption extends CollectorOption {
  description: string;
  metrics: Array<{
    id: string;
    label: string;
    kind: string;
    unit: string;
  }>;
}

type SetupResult = ActionResult<{ created: number; authorityNeedsConfirmation: number }>;
type SetupAction = (
  prev: SetupResult | undefined,
  formData: FormData,
) => Promise<SetupResult>;

/** One task-oriented form creates quota + local binding from the server catalog. */
export function LocalCollectorSetupForm({
  action,
  subscriptions,
  collectors,
}: Readonly<{
  action: SetupAction;
  subscriptions: SubscriptionOption[];
  collectors: CollectorCatalogOption[];
}>) {
  const [state, formAction, pending] = useActionState(action, undefined);
  const [collectorId, setCollectorId] = useState(collectors[0]?.id ?? "");
  const collector = collectors.find((item) => item.id === collectorId) ?? collectors[0];

  return (
    <form className="form collector-setup" action={formAction}>
      <GlobalError state={state} />
      <div className="field-row">
        <div className="field">
          <label htmlFor="local-subscription">归属订阅</label>
          <select id="local-subscription" name="subscriptionId" required defaultValue="">
            <option value="" disabled>请选择订阅</option>
            {subscriptions.map((subscription) => (
              <option key={subscription.id} value={subscription.id}>{subscription.name}</option>
            ))}
          </select>
          <FieldError state={state} name="subscriptionId" />
        </div>
        <div className="field">
          <label htmlFor="local-collector">本机产品</label>
          <select
            id="local-collector"
            name="collectorId"
            value={collectorId}
            onChange={(event) => setCollectorId(event.target.value)}
            required
          >
            {collectors.map((item) => (
              <option key={item.id} value={item.id}>{item.displayName}</option>
            ))}
          </select>
          <p className="field-hint">{collector?.description}</p>
          <FieldError state={state} name="collectorId" />
        </div>
      </div>
      <fieldset className="metric-picker">
        <legend>采集指标</legend>
        <p className="field-hint">只显示采集器真实支持的指标，可一次配置多个。</p>
        <div className="metric-options">
          {collector?.metrics.map((metric, index) => (
            <label key={metric.id} className="metric-option">
              <input
                type="checkbox"
                name="metrics"
                value={metric.id}
                defaultChecked={index < 2}
                key={`${collector.id}:${metric.id}`}
              />
              <span><strong>{metric.label}</strong><small>{metric.kind} · {metric.unit}</small></span>
            </label>
          ))}
        </div>
        <FieldError state={state} name="metrics" />
      </fieldset>
      <div className="actions">
        <button className="button" type="submit" disabled={pending || subscriptions.length === 0}>
          {pending ? "正在创建…" : "创建本地采集来源"}
        </button>
        {state?.ok && (
          <span className="tag ok" role="status">
            已配置 {state.data?.created ?? 0} 张新额度
            {(state.data?.authorityNeedsConfirmation ?? 0) > 0 ? "，已有额度需确认来源" : ""}
          </span>
        )}
      </div>
    </form>
  );
}

/** 为一张 quota 指定本地采集器（通道 B 绑定入口，design §7.4）。 */
export function LocalBindingForm({
  action,
  quotaId,
  collectors,
}: Readonly<{ action: Action; quotaId: string; collectors: CollectorOption[] }>) {
  const [state, formAction, pending] = useActionState(action, undefined);
  const prefix = collectors[0]?.metricPrefix ?? "";
  return (
    <form className="form" action={formAction}>
      <GlobalError state={state} />
      <input type="hidden" name="quotaId" value={quotaId} />
      <div className="field-row">
        <div className="field">
          <label htmlFor={`collector-${quotaId}`}>采集器</label>
          <select id={`collector-${quotaId}`} name="collectorId" required>
            {collectors.map((c) => (
              <option key={c.id} value={c.id}>
                {c.displayName}
              </option>
            ))}
          </select>
          <FieldError state={state} name="collectorId" />
        </div>
        <div className="field">
          <label htmlFor={`metric-${quotaId}`}>指标</label>
          <input
            id={`metric-${quotaId}`}
            name="metric"
            placeholder={`${prefix}…`}
            required
          />
          <FieldError state={state} name="metric" />
        </div>
        <div className="field" style={{ justifyContent: "end" }}>
          <button className="button secondary" type="submit" disabled={pending}>
            {pending ? "绑定中…" : "绑定采集器"}
          </button>
          {state?.ok && <span className="tag" role="status">已绑定</span>}
        </div>
      </div>
    </form>
  );
}

export function ManualUsageUpdateForm({
  action,
  quotaId,
  kind,
}: Readonly<{ action: Action; quotaId: string; kind: string }>) {  const [state, formAction, pending] = useActionState(action, undefined);
  return (
    <form className="form" action={formAction}>
      <GlobalError state={state} />
      <input type="hidden" name="quotaId" value={quotaId} />
      <div className="field-row">
        {kind !== "balance" && (
          <div className="field">
            <label htmlFor={`used-${quotaId}`}>已用</label>
            <input id={`used-${quotaId}`} name="usedValue" inputMode="decimal" />
            <FieldError state={state} name="usedValue" />
          </div>
        )}
        {kind === "balance" && (
          <div className="field">
            <label htmlFor={`remaining-${quotaId}`}>剩余</label>
            <input id={`remaining-${quotaId}`} name="remainingValue" inputMode="decimal" />
            <FieldError state={state} name="remainingValue" />
          </div>
        )}
        <div className="field" style={{ justifyContent: "end" }}>
          <button className="button secondary" type="submit" disabled={pending}>
            {pending ? "保存中…" : "更新读数"}
          </button>
          {state?.ok && <span className="tag" role="status">已更新</span>}
        </div>
      </div>
    </form>
  );
}
