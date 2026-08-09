"use client";

import { useActionState } from "react";

import type { ActionResult } from "@/server/settings/actions";

import { FieldError, GlobalError } from "./general-forms";

type Action = (
  prev: ActionResult | undefined,
  formData: FormData,
) => Promise<ActionResult>;

export interface ProviderOption {
  id: string;
  displayName: string;
}

export interface SubscriptionOption {
  id: string;
  name: string;
}

const UNIT_OPTIONS = ["CNY", "USD", "EUR", "JPY"];

export function ConnectProviderForm({
  action,
  providers,
  subscriptions,
}: Readonly<{
  action: Action;
  providers: ProviderOption[];
  subscriptions: SubscriptionOption[];
}>) {
  const [state, formAction, pending] = useActionState(action, undefined);
  return (
    <form className="form" action={formAction}>
      <GlobalError state={state} />
      <div className="field-row">
        <div className="field">
          <label htmlFor="providerId">服务商</label>
          <select id="providerId" name="providerId" required>
            <option value="">请选择</option>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.displayName}
              </option>
            ))}
          </select>
          <FieldError state={state} name="providerId" />
        </div>
        <div className="field">
          <label htmlFor="displayName">显示名</label>
          <input id="displayName" name="displayName" placeholder="我的 DeepSeek" required />
          <FieldError state={state} name="displayName" />
        </div>
      </div>
      <div className="field">
        <label htmlFor="apiKey">API Key</label>
        <input
          id="apiKey"
          name="apiKey"
          type="password"
          autoComplete="off"
          required
          minLength={8}
        />
        <p className="field-hint">AES-256-GCM 加密后入库，只用于用量同步，不再回显</p>
        <FieldError state={state} name="apiKey" />
      </div>
      <div className="field-row">
        <div className="field">
          <label htmlFor="subscriptionId">余额计入哪条订阅</label>
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
        <div className="field">
          <label htmlFor="unit">余额币种</label>
          <select id="unit" name="unit" defaultValue="CNY">
            {UNIT_OPTIONS.map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </select>
          <FieldError state={state} name="unit" />
        </div>
      </div>
      <div className="field">
        <label htmlFor="scopes">scopes（可选）</label>
        <input id="scopes" name="scopes" placeholder="xai:team:<teamId> 或 kimi:international" />
        <p className="field-hint">
          xAI 管理 Key 必填 `xai:team:&lt;teamId&gt;`；Kimi 国际站填 `kimi:international`，其余留空
        </p>
        <FieldError state={state} name="scopes" />
      </div>
      <div className="actions">
        <button className="button" type="submit" disabled={pending}>
          {pending ? "保存中…" : "添加连接"}
        </button>
        {state?.ok && <span className="tag" role="status">已添加</span>}
      </div>
    </form>
  );
}
