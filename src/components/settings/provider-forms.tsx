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

export function ConnectProviderForm({
  action,
  providers,
}: Readonly<{ action: Action; providers: ProviderOption[] }>) {
  const [state, formAction, pending] = useActionState(action, undefined);
  return (
    <form className="form" action={formAction}>
      <GlobalError state={state} />
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
      <div className="actions">
        <button className="button" type="submit" disabled={pending}>
          {pending ? "保存中…" : "添加连接"}
        </button>
        {state?.ok && <span className="tag">已添加</span>}
      </div>
    </form>
  );
}
