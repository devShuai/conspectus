"use client";

import { useActionState } from "react";

import type { ActionResult } from "@/server/billing/subscription-actions";

export interface VendorOption {
  id: string;
  name: string;
  isSystem: boolean;
}

export interface SubscriptionFormValues {
  id?: string;
  name: string;
  planName: string;
  status: string;
  price: string;
  currency: string;
  billingCycle: string;
  cycleDays: string;
  anchorDay: string;
  startedAt: string;
  trialEndsAt: string;
  autoRenew: boolean;
  vendorId: string;
  tags: string;
  notes: string;
}

const CYCLES: Array<[string, string]> = [
  ["weekly", "每周"],
  ["monthly", "每月"],
  ["quarterly", "每季"],
  ["yearly", "每年"],
  ["custom", "自定义天数"],
  ["lifetime", "买断"],
  ["one_time", "一次性"],
];

const STATUSES: Array<[string, string]> = [
  ["trial", "试用中"],
  ["active", "生效中"],
  ["paused", "已暂停"],
  ["canceled", "已取消"],
  ["expired", "已到期"],
];

function FieldError({ errors }: Readonly<{ errors?: string[] }>) {
  if (!errors?.length) return null;
  return <p className="field-error">{errors.join("；")}</p>;
}

export default function SubscriptionForm({
  action,
  values,
  vendorOptions,
  submitLabel,
}: Readonly<{
  action: (
    prev: ActionResult<{ id: string }> | undefined,
    formData: FormData,
  ) => Promise<ActionResult<{ id: string }>>;
  values: SubscriptionFormValues;
  vendorOptions: VendorOption[];
  submitLabel: string;
}>) {
  const [state, formAction, pending] = useActionState(action, undefined);
  const fieldErrors = state && !state.ok ? state.error.fieldErrors : undefined;

  return (
    <form action={formAction} className="form">
      {values.id && <input type="hidden" name="id" value={values.id} />}

      {state && !state.ok && (
        <p className="form-error" role="alert">
          {state.error.message}
        </p>
      )}

      <div className="field">
        <label htmlFor="name">名称</label>
        <input id="name" name="name" defaultValue={values.name} required maxLength={120} />
        <FieldError errors={fieldErrors?.name} />
      </div>

      <div className="field-row">
        <div className="field">
          <label htmlFor="vendorId">服务商</label>
          <select id="vendorId" name="vendorId" defaultValue={values.vendorId}>
            <option value="">（不指定）</option>
            {vendorOptions.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
                {v.isSystem ? "" : "（自建）"}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="planName">套餐档位</label>
          <input id="planName" name="planName" defaultValue={values.planName} />
        </div>
      </div>

      <div className="field-row">
        <div className="field">
          <label htmlFor="price">价格（单周期）</label>
          <input
            id="price"
            name="price"
            type="number"
            step="0.01"
            min="0"
            defaultValue={values.price}
            required
          />
          <FieldError errors={fieldErrors?.price} />
        </div>
        <div className="field">
          <label htmlFor="currency">币种</label>
          <input
            id="currency"
            name="currency"
            defaultValue={values.currency}
            placeholder="CNY"
            maxLength={3}
            required
          />
          <FieldError errors={fieldErrors?.currency} />
        </div>
      </div>

      <div className="field-row">
        <div className="field">
          <label htmlFor="billingCycle">计费周期</label>
          <select id="billingCycle" name="billingCycle" defaultValue={values.billingCycle}>
            {CYCLES.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <FieldError errors={fieldErrors?.billingCycle} />
        </div>
        <div className="field">
          <label htmlFor="cycleDays">自定义天数</label>
          <input
            id="cycleDays"
            name="cycleDays"
            type="number"
            min="1"
            defaultValue={values.cycleDays}
          />
          <p className="field-hint">仅「自定义天数」周期填写</p>
          <FieldError errors={fieldErrors?.cycleDays} />
        </div>
      </div>

      <div className="field-row">
        <div className="field">
          <label htmlFor="startedAt">首次计费日</label>
          <input
            id="startedAt"
            name="startedAt"
            type="date"
            defaultValue={values.startedAt}
            required
          />
          <FieldError errors={fieldErrors?.startedAt} />
        </div>
        <div className="field">
          <label htmlFor="anchorDay">锚定日</label>
          <input
            id="anchorDay"
            name="anchorDay"
            type="number"
            min="1"
            max="31"
            defaultValue={values.anchorDay}
          />
          <p className="field-hint">月/季/年周期用；月末不漂移</p>
          <FieldError errors={fieldErrors?.anchorDay} />
        </div>
      </div>

      <div className="field-row">
        <div className="field">
          <label htmlFor="status">状态</label>
          <select id="status" name="status" defaultValue={values.status}>
            {STATUSES.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <FieldError errors={fieldErrors?.status} />
        </div>
        <div className="field">
          <label htmlFor="trialEndsAt">试用结束日</label>
          <input
            id="trialEndsAt"
            name="trialEndsAt"
            type="date"
            defaultValue={values.trialEndsAt}
          />
          <p className="field-hint">状态为「试用中」时必填；价格填转正后的定价</p>
          <FieldError errors={fieldErrors?.trialEndsAt} />
        </div>
      </div>

      <div className="field">
        <label className="checkbox">
          <input type="checkbox" name="autoRenew" defaultChecked={values.autoRenew} />
          <span>自动续费</span>
        </label>
        <p className="field-hint">关闭后到期只提醒、不生成待付账单</p>
      </div>

      <div className="field">
        <label htmlFor="tags">标签</label>
        <input id="tags" name="tags" defaultValue={values.tags} placeholder="逗号分隔" />
      </div>

      <div className="field">
        <label htmlFor="notes">备注</label>
        <textarea id="notes" name="notes" rows={3} defaultValue={values.notes} />
      </div>

      <div className="actions">
        <button type="submit" className="button" disabled={pending}>
          {pending ? "保存中…" : submitLabel}
        </button>
      </div>
    </form>
  );
}
