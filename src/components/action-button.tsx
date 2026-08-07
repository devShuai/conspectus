"use client";

import { useActionState } from "react";

import type { ActionResult } from "@/server/billing/subscription-actions";

/**
 * Submits a Server Action that follows the §8 `{ ok }` contract from a plain
 * button. A bare <form action> would require the action to return void, which
 * would silently drop errors — this surfaces them instead.
 */
export default function ActionButton({
  action,
  fields,
  label,
  pendingLabel,
  confirm,
  variant,
}: Readonly<{
  action: (
    prev: ActionResult | undefined,
    formData: FormData,
  ) => Promise<ActionResult>;
  fields: Record<string, string>;
  label: string;
  pendingLabel?: string;
  confirm?: string;
  variant?: "danger";
}>) {
  const [state, formAction, pending] = useActionState(action, undefined);

  return (
    <form
      action={formAction}
      onSubmit={(event) => {
        if (confirm && !window.confirm(confirm)) event.preventDefault();
      }}
    >
      {Object.entries(fields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <button
        type="submit"
        className={`button secondary${variant === "danger" ? " danger" : ""}`}
        disabled={pending}
      >
        {pending ? (pendingLabel ?? "处理中…") : label}
      </button>
      {state && !state.ok && (
        <span className="field-error" role="alert">
          {state.error.message}
        </span>
      )}
    </form>
  );
}
