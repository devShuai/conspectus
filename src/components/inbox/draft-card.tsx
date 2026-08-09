"use client";

import { useActionState, useEffect, useState } from "react";

import ActionButton from "@/components/action-button";
import { formatMoney } from "@/components/money";
import type { DraftActionResult } from "@/server/import/draft-actions";

/**
 * Inbox 草稿卡片（#61，design §7.5）：解析字段、置信度与来源证据的展示 +
 * 校正编辑 + 接受/拒绝。所有字段一律按纯文本渲染（React 转义），payload 的
 * strict schema 保证没有 HTML/脚本可携带 —— 绝不渲染未净化的原始邮件 HTML。
 */

type DraftAction = (
  prev: DraftActionResult | undefined,
  formData: FormData,
) => Promise<DraftActionResult>;

const CYCLE_LABEL: Record<string, string> = {
  weekly: "每周",
  monthly: "每月",
  quarterly: "每季",
  yearly: "每年",
  custom: "自定义",
  lifetime: "买断",
  one_time: "一次性",
};

// 与 draft-actions 的 BILLING_CYCLES 一致：payload 无 cycleDays，不提供 custom
const CYCLE_OPTIONS: Array<[string, string]> = [
  ["monthly", "每月"],
  ["quarterly", "每季"],
  ["yearly", "每年"],
  ["weekly", "每周"],
  ["lifetime", "买断"],
  ["one_time", "一次性"],
];

function FieldError({ errors }: Readonly<{ errors?: string[] }>) {
  if (!errors?.length) return null;
  return <p className="field-error">{errors.join("；")}</p>;
}

export default function DraftCard({
  id,
  name,
  planName,
  amount,
  currency,
  billedAt,
  billingCycle,
  reference,
  confidencePercent,
  lowConfidence,
  matchedRule,
  fromAddr,
  subject,
  sourceReceivedAt,
  expiresAtLabel,
  expired,
  hasSuggestion,
  suggestedSubscriptionName,
  updateAction,
  acceptAction,
  rejectAction,
}: Readonly<{
  id: string;
  name: string;
  planName: string | null;
  amount: string;
  currency: string;
  billedAt: string;
  billingCycle: string | null;
  reference: string | null;
  /** 已格式化的百分比数字，如 "95" / "62.5"。 */
  confidencePercent: string;
  /** confidence < 0.9：不预选，接受前必须人工确认（§7.5）。 */
  lowConfidence: boolean;
  matchedRule: string | null;
  fromAddr: string | null;
  subject: string | null;
  sourceReceivedAt: string | null;
  expiresAtLabel: string;
  expired: boolean;
  hasSuggestion: boolean;
  suggestedSubscriptionName: string | null;
  updateAction: DraftAction;
  acceptAction: DraftAction;
  rejectAction: DraftAction;
}>) {
  const [editing, setEditing] = useState(false);
  const [state, formAction, pending] = useActionState(updateAction, undefined);
  const fieldErrors = state && !state.ok ? state.error.fieldErrors : undefined;

  // 保存成功后收起编辑区；revalidatePath 带回的新值通过 key 重挂载表单
  useEffect(() => {
    if (state?.ok) setEditing(false);
  }, [state]);

  const formKey = JSON.stringify([name, planName, amount, currency, billedAt, billingCycle, reference]);

  return (
    <section className="usage-card">
      <div className="draft-card-head">
        <strong>{name}</strong>
        {planName && <span className="muted">{planName}</span>}
        <span className={`tag ${lowConfidence ? "warn" : "ok"}`}>
          置信度 {confidencePercent}%
        </span>
        {lowConfidence && <span className="tag warn">需人工核对</span>}
        {expired && <span className="tag off">已过期</span>}
        <span className="money">{formatMoney(Number(amount), currency)}</span>
      </div>

      <p className="draft-meta">
        扣费日 {billedAt} · {CYCLE_LABEL[billingCycle ?? "monthly"] ?? billingCycle}
        {reference ? ` · 单号 ${reference}` : ""}
      </p>
      <p className="draft-meta">
        来源 {fromAddr ?? "未知发件人"}
        {subject ? ` · ${subject}` : ""}
        {sourceReceivedAt
          ? ` · 收到于 ${sourceReceivedAt.slice(0, 10)} ${sourceReceivedAt.slice(11, 16)} UTC`
          : ""}
        {matchedRule ? ` · 规则 ${matchedRule}` : " · 通用启发式"}
      </p>
      <p className="draft-meta">
        {hasSuggestion
          ? `接受后记账到已有订阅「${suggestedSubscriptionName ?? "…"}」`
          : "接受后将新建订阅"}
        {` · 草稿 ${expiresAtLabel} 过期`}
      </p>

      {!expired && !editing && (
        <div className="actions">
          <ActionButton
            action={acceptAction}
            fields={{ id }}
            label="接受并入账"
            pendingLabel="入账中…"
            confirm={
              lowConfidence
                ? `该草稿置信度仅 ${confidencePercent}%，请确认名称、金额、币种与扣费日无误。确定接受并入账？`
                : undefined
            }
          />
          <button type="button" className="button secondary" onClick={() => setEditing(true)}>
            编辑
          </button>
          <ActionButton
            action={rejectAction}
            fields={{ id }}
            label="拒绝"
            pendingLabel="拒绝中…"
            confirm="拒绝后草稿不再可接受，也不会入账。确定拒绝？"
            variant="danger"
          />
        </div>
      )}

      {!expired && editing && (
        <form action={formAction} className="form" key={formKey}>
          <input type="hidden" name="id" value={id} />
          {state && !state.ok && (
            <p className="form-error" role="alert">
              {state.error.message}
            </p>
          )}

          <div className="field-row">
            <div className="field">
              <label htmlFor={`name-${id}`}>名称</label>
              <input id={`name-${id}`} name="name" defaultValue={name} required maxLength={200} />
              <FieldError errors={fieldErrors?.name} />
            </div>
            <div className="field">
              <label htmlFor={`planName-${id}`}>套餐档位</label>
              <input id={`planName-${id}`} name="planName" defaultValue={planName ?? ""} maxLength={200} />
            </div>
          </div>

          <div className="field-row">
            <div className="field">
              <label htmlFor={`amount-${id}`}>金额</label>
              <input
                id={`amount-${id}`}
                name="amount"
                type="number"
                step="0.01"
                min="0"
                defaultValue={amount}
                required
              />
              <FieldError errors={fieldErrors?.amount} />
            </div>
            <div className="field">
              <label htmlFor={`currency-${id}`}>币种</label>
              <input
                id={`currency-${id}`}
                name="currency"
                defaultValue={currency}
                required
                maxLength={3}
                pattern="[A-Za-z]{3}"
              />
              <FieldError errors={fieldErrors?.currency} />
            </div>
          </div>

          <div className="field-row">
            <div className="field">
              <label htmlFor={`billedAt-${id}`}>扣费日</label>
              <input id={`billedAt-${id}`} name="billedAt" type="date" defaultValue={billedAt} required />
              <FieldError errors={fieldErrors?.billedAt} />
            </div>
            <div className="field">
              <label htmlFor={`billingCycle-${id}`}>账期</label>
              <select
                id={`billingCycle-${id}`}
                name="billingCycle"
                defaultValue={billingCycle ?? "monthly"}
              >
                {CYCLE_OPTIONS.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="field">
            <label htmlFor={`reference-${id}`}>单号（可选）</label>
            <input id={`reference-${id}`} name="reference" defaultValue={reference ?? ""} maxLength={200} />
          </div>

          <div className="actions">
            <button type="submit" className="button" disabled={pending}>
              {pending ? "保存中…" : "保存修改"}
            </button>
            <button
              type="button"
              className="button secondary"
              disabled={pending}
              onClick={() => setEditing(false)}
            >
              取消
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
