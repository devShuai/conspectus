"use client";

import { useActionState } from "react";

import type { ActionResult } from "@/server/settings/actions";

type Action = (
  prev: ActionResult | undefined,
  formData: FormData,
) => Promise<ActionResult>;

function GlobalError({ state }: { state: ActionResult | undefined }) {
  if (!state || state.ok) return null;
  return (
    <p className="form-error" role="alert">
      {state.error.message}
    </p>
  );
}

function FieldError({ state, name }: { state: ActionResult | undefined; name: string }) {
  if (!state || state.ok) return null;
  const messages = state.error.fieldErrors?.[name];
  if (!messages?.length) return null;
  return (
    <p className="field-error" role="alert">
      {messages[0]}
    </p>
  );
}

export { GlobalError, FieldError };

export function TimezoneForm({
  action,
  current,
}: Readonly<{ action: Action; current: string }>) {
  const [state, formAction, pending] = useActionState(action, undefined);
  return (
    <form className="form" action={formAction}>
      <GlobalError state={state} />
      <div className="field">
        <label htmlFor="timezone">时区（IANA）</label>
        <input id="timezone" name="timezone" defaultValue={current} required />
        <p className="field-hint">影响提醒发送时刻与续费日计算，如 Asia/Shanghai</p>
        <FieldError state={state} name="timezone" />
      </div>
      <div className="actions">
        <button className="button" type="submit" disabled={pending}>
          {pending ? "保存中…" : "保存时区"}
        </button>
        {state?.ok && <span className="tag">已保存</span>}
      </div>
    </form>
  );
}

export function RebaseForm({
  action,
  current,
  disabled,
}: Readonly<{ action: Action; current: string; disabled?: boolean }>) {
  const [state, formAction, pending] = useActionState(action, undefined);
  return (
    <form className="form" action={formAction}>
      <GlobalError state={state} />
      <div className="field">
        <label htmlFor="currency">新本位币（当前 {current}）</label>
        <input
          id="currency"
          name="currency"
          placeholder="USD / EUR / JPY…"
          maxLength={3}
          required
          disabled={disabled}
        />
        <p className="field-hint">
          变更会先异步补齐全部历史投影，完成后才切换；期间报表口径保持旧币种
        </p>
        <FieldError state={state} name="currency" />
      </div>
      <div className="actions">
        <button className="button" type="submit" disabled={pending || disabled}>
          {pending ? "提交中…" : "变更本位币"}
        </button>
        {state?.ok && <span className="tag">已提交</span>}
      </div>
    </form>
  );
}
