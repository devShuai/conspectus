"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { currentAppSession } from "@/server/auth/current-session";
import { BillingError } from "@/server/billing/billing";
import { isSupportedCurrency } from "@/server/billing/fx";
import { TenantError } from "@/server/billing/subscriptions";

import {
  DraftError,
  acceptDraft,
  rejectDraft,
  updateDraftCandidate,
} from "./drafts";

/**
 * Inbox 草稿的 Server Actions（#61，design §8）：固定顺序 requireUser() →
 * Zod → tenant-aware service → revalidatePath。每个 Action 都按公开 HTTP
 * 端点处理，userId 只取自 Session。
 */

export type DraftActionResult =
  | { ok: true; data?: undefined }
  | {
      ok: false;
      error: { code: string; message: string; fieldErrors?: Record<string, string[]> };
    };

function draftActionError(cause: unknown): DraftActionResult {
  if (cause instanceof DraftError) {
    return { ok: false, error: { code: cause.code, message: cause.message } };
  }
  if (cause instanceof TenantError) {
    return { ok: false, error: { code: cause.code, message: cause.message } };
  }
  if (cause instanceof BillingError) {
    return { ok: false, error: { code: cause.code, message: cause.message } };
  }
  return { ok: false, error: { code: "server_error", message: "操作失败，请稍后重试" } };
}

function toFieldErrors(error: z.ZodError): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "_";
    (out[key] ??= []).push(issue.message);
  }
  return out;
}

// 与 draft-payload.ts 的 candidate 约束同源；custom 周期需要 cycleDays，而
// payload 没有该字段，Inbox 编辑不提供（接受时也不会产生 custom 订阅）
const BILLING_CYCLES = [
  "weekly",
  "monthly",
  "quarterly",
  "yearly",
  "lifetime",
  "one_time",
] as const;

const optionalText = z
  .string()
  .trim()
  .max(200)
  .transform((v) => (v === "" ? undefined : v));

const DraftEditSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1, "名称不能为空").max(200),
  planName: optionalText,
  amount: z.string().trim().regex(/^\d+(\.\d{1,2})?$/, "金额需为十进制数字"),
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/, "币种需为 3 位 ISO-4217 代码")
    .refine(isSupportedCurrency, "汇率源暂不覆盖该币种"),
  billedAt: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "扣费日需为 YYYY-MM-DD")
    .refine(
      (v) => !Number.isNaN(new Date(`${v}T00:00:00.000Z`).getTime()),
      "扣费日不是合法日历日",
    ),
  billingCycle: z.enum(BILLING_CYCLES),
  reference: optionalText,
});

/** 保存草稿字段校正；仅 pending 且未过期可改，订阅建议随字段重算。 */
export async function updateDraftAction(
  _prev: DraftActionResult | undefined,
  formData: FormData,
): Promise<DraftActionResult> {
  const session = await currentAppSession();
  if (!session) {
    return { ok: false, error: { code: "forbidden", message: "需要登录" } };
  }

  const parsed = DraftEditSchema.safeParse({
    id: formData.get("id") ?? "",
    name: formData.get("name") ?? "",
    planName: formData.get("planName") ?? "",
    amount: formData.get("amount") ?? "",
    currency: formData.get("currency") ?? "",
    billedAt: formData.get("billedAt") ?? "",
    billingCycle: formData.get("billingCycle") ?? "",
    reference: formData.get("reference") ?? "",
  });
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        code: "invalid_input",
        message: "请检查表单内容",
        fieldErrors: toFieldErrors(parsed.error),
      },
    };
  }

  try {
    await updateDraftCandidate(session.userId, parsed.data.id, parsed.data);
    revalidatePath("/inbox");
    return { ok: true };
  } catch (cause) {
    return draftActionError(cause);
  }
}

const IdSchema = z.string().uuid();

/** 接受草稿：建订阅（无建议时）并写 BillingRecord(status=paid) + 投影。 */
export async function acceptDraftAction(
  _prev: DraftActionResult | undefined,
  formData: FormData,
): Promise<DraftActionResult> {
  const session = await currentAppSession();
  if (!session) {
    return { ok: false, error: { code: "forbidden", message: "需要登录" } };
  }
  const id = IdSchema.safeParse(formData.get("id"));
  if (!id.success) {
    return { ok: false, error: { code: "invalid_input", message: "缺少草稿 ID" } };
  }

  try {
    await acceptDraft(session.userId, id.data);
    revalidatePath("/inbox");
    revalidatePath("/subscriptions");
    revalidatePath("/");
    return { ok: true };
  } catch (cause) {
    return draftActionError(cause);
  }
}

/** 拒绝草稿：CAS pending→rejected，行保留作审计。 */
export async function rejectDraftAction(
  _prev: DraftActionResult | undefined,
  formData: FormData,
): Promise<DraftActionResult> {
  const session = await currentAppSession();
  if (!session) {
    return { ok: false, error: { code: "forbidden", message: "需要登录" } };
  }
  const id = IdSchema.safeParse(formData.get("id"));
  if (!id.success) {
    return { ok: false, error: { code: "invalid_input", message: "缺少草稿 ID" } };
  }

  try {
    await rejectDraft(session.userId, id.data);
    revalidatePath("/inbox");
    return { ok: true };
  } catch (cause) {
    return draftActionError(cause);
  }
}
