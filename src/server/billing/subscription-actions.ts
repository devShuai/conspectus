"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { currentAppSession } from "@/server/auth/current-session";
import { isSupportedCurrency } from "@/server/billing/fx";
import {
  TenantError,
  changeSubscriptionStatus,
  createSubscription,
  deleteSubscription,
  updateSubscription,
} from "./subscriptions";

/**
 * Server Actions for subscription CRUD (design.md §8).
 *
 * Fixed order for every action: requireUser() -> Zod -> tenant-aware service
 * -> write. The caller-supplied userId is always ignored; the tenant id can
 * only come from the session.
 */

export type ActionResult<T = undefined> =
  | { ok: true; data?: T }
  | { ok: false; error: { code: string; message: string; fieldErrors?: Record<string, string[]> } };

async function requireUser(): Promise<string> {
  const session = await currentAppSession();
  if (!session) throw new TenantError("forbidden", "authentication required");
  return session.userId;
}

const BILLING_CYCLES = [
  "weekly",
  "monthly",
  "quarterly",
  "yearly",
  "custom",
  "lifetime",
  "one_time",
] as const;

const STATUSES = ["trial", "active", "paused", "canceled", "expired"] as const;

/** "" -> undefined, so untouched optional inputs do not overwrite stored values. */
const optionalText = z
  .string()
  .trim()
  .transform((v) => (v === "" ? undefined : v));

const optionalDate = z
  .string()
  .trim()
  .transform((v) => (v === "" ? undefined : new Date(v)))
  .refine((v) => v === undefined || !Number.isNaN(v.getTime()), "日期不合法");

const optionalInt = z
  .string()
  .trim()
  .transform((v) => (v === "" ? undefined : Number(v)))
  .refine(
    (v) => v === undefined || (Number.isInteger(v) && Number.isFinite(v)),
    "需为整数",
  );

const SubscriptionFormSchema = z.object({
  name: z.string().trim().min(1, "名称不能为空").max(120),
  planName: optionalText,
  status: z.enum(STATUSES),
  price: z.coerce.number().min(0, "价格不能为负"),
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/, "币种需为 3 位 ISO-4217 代码")
    .refine(isSupportedCurrency, "汇率源暂不覆盖该币种"),
  billingCycle: z.enum(BILLING_CYCLES),
  cycleDays: optionalInt,
  anchorDay: optionalInt,
  startedAt: z.coerce.date(),
  trialEndsAt: optionalDate,
  autoRenew: z
    .union([z.literal("on"), z.literal("")])
    .optional()
    .transform((v) => v === "on"),
  vendorId: optionalText,
  tags: z
    .string()
    .trim()
    .transform((v) =>
      v === "" ? [] : v.split(",").map((t) => t.trim()).filter(Boolean),
    ),
  notes: optionalText,
});

function toFieldErrors(error: z.ZodError): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "_";
    (out[key] ??= []).push(issue.message);
  }
  return out;
}

function toActionError(cause: unknown): ActionResult {
  if (cause instanceof TenantError) {
    return { ok: false, error: { code: cause.code, message: cause.message } };
  }
  return { ok: false, error: { code: "server_error", message: "操作失败，请稍后重试" } };
}

function parseForm(formData: FormData) {
  return SubscriptionFormSchema.safeParse({
    name: formData.get("name") ?? "",
    planName: formData.get("planName") ?? "",
    status: formData.get("status") ?? "active",
    price: formData.get("price") ?? "",
    currency: formData.get("currency") ?? "",
    billingCycle: formData.get("billingCycle") ?? "monthly",
    cycleDays: formData.get("cycleDays") ?? "",
    anchorDay: formData.get("anchorDay") ?? "",
    startedAt: formData.get("startedAt") ?? "",
    trialEndsAt: formData.get("trialEndsAt") ?? "",
    autoRenew: formData.get("autoRenew") ?? "",
    vendorId: formData.get("vendorId") ?? "",
    tags: formData.get("tags") ?? "",
    notes: formData.get("notes") ?? "",
  });
}

export async function createSubscriptionAction(
  _prev: ActionResult<{ id: string }> | undefined,
  formData: FormData,
): Promise<ActionResult<{ id: string }>> {
  let userId: string;
  try {
    userId = await requireUser();
  } catch (cause) {
    return toActionError(cause) as ActionResult<{ id: string }>;
  }

  const parsed = parseForm(formData);
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

  let createdId: string;
  try {
    const created = await createSubscription(userId, {
      ...parsed.data,
      planName: parsed.data.planName ?? null,
      cycleDays: parsed.data.cycleDays ?? null,
      anchorDay: parsed.data.anchorDay ?? null,
      trialEndsAt: parsed.data.trialEndsAt ?? null,
      notes: parsed.data.notes ?? null,
      vendorId: parsed.data.vendorId ?? null,
    });
    createdId = created.id;
    revalidatePath("/subscriptions");
    revalidatePath("/");
  } catch (cause) {
    return toActionError(cause) as ActionResult<{ id: string }>;
  }
  // redirect() signals via a thrown control-flow error; it must stay outside
  // the try above or toActionError would swallow it into a generic failure.
  redirect(`/subscriptions/${createdId}`);
}

export async function updateSubscriptionAction(
  _prev: ActionResult<{ id: string }> | undefined,
  formData: FormData,
): Promise<ActionResult<{ id: string }>> {
  let userId: string;
  try {
    userId = await requireUser();
  } catch (cause) {
    return toActionError(cause);
  }

  const id = String(formData.get("id") ?? "");
  if (!id) return { ok: false, error: { code: "invalid_input", message: "缺少订阅 ID" } };

  const parsed = parseForm(formData);
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
    await updateSubscription(userId, id, {
      ...parsed.data,
      planName: parsed.data.planName ?? null,
      cycleDays: parsed.data.cycleDays ?? null,
      anchorDay: parsed.data.anchorDay ?? null,
      trialEndsAt: parsed.data.trialEndsAt ?? null,
      notes: parsed.data.notes ?? null,
      vendorId: parsed.data.vendorId ?? null,
    });
    revalidatePath("/subscriptions");
    revalidatePath(`/subscriptions/${id}`);
    revalidatePath("/");
    return { ok: true, data: { id } };
  } catch (cause) {
    return toActionError(cause) as ActionResult<{ id: string }>;
  }
}

const StatusSchema = z.enum(STATUSES);

export async function changeSubscriptionStatusAction(
  _prev: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  let userId: string;
  try {
    userId = await requireUser();
  } catch (cause) {
    return toActionError(cause);
  }

  const id = String(formData.get("id") ?? "");
  const status = StatusSchema.safeParse(formData.get("status"));
  if (!id || !status.success) {
    return { ok: false, error: { code: "invalid_input", message: "参数不合法" } };
  }

  try {
    await changeSubscriptionStatus(userId, id, status.data);
    revalidatePath("/subscriptions");
    revalidatePath(`/subscriptions/${id}`);
    revalidatePath("/");
    return { ok: true };
  } catch (cause) {
    return toActionError(cause);
  }
}

export async function deleteSubscriptionAction(
  _prev: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  let userId: string;
  try {
    userId = await requireUser();
  } catch (cause) {
    return toActionError(cause);
  }

  const id = String(formData.get("id") ?? "");
  if (!id) return { ok: false, error: { code: "invalid_input", message: "缺少订阅 ID" } };

  try {
    await deleteSubscription(userId, id);
    revalidatePath("/subscriptions");
    revalidatePath("/");
  } catch (cause) {
    return toActionError(cause);
  }
  redirect("/subscriptions");
}
