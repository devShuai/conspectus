"use client";

import { useActionState } from "react";

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
        {state?.ok && <span className="tag">已创建</span>}
      </div>
    </form>
  );
}

export interface CollectorOption {
  id: string;
  displayName: string;
  metricPrefix: string;
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
          {state?.ok && <span className="tag">已绑定</span>}
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
          {state?.ok && <span className="tag">已更新</span>}
        </div>
      </div>
    </form>
  );
}
