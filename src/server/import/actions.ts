"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { currentAppSession } from "@/server/auth/current-session";
import { TenantError } from "@/server/billing/subscriptions";
import {
  InboundAliasError,
  clearInboundRawNow,
  revokeInboundAlias,
  rotateInboundAlias,
  setInboundRawRetention,
} from "./alias";
import {
  CONFLICT_STRATEGIES,
  ImportError,
  executeSubscriptionImport,
  type ImportExecuteResult,
} from "./subscriptions";

/**
 * CSV 导入第三步（design §7.7）：确认执行。固定顺序 requireUser() -> Zod ->
 * 服务端重新解析校验（绝不信任客户端预检结果）-> 按冲突策略写入。
 * 幂等：同一 CSV 重复确认不产生重复行。
 */

export type ImportActionResult =
  | { ok: true; data?: ImportExecuteResult }
  | { ok: false; error: { code: string; message: string } };

const ConfirmSchema = z.object({
  csv: z.string().min(1, "CSV 内容为空").max(600 * 1024, "CSV 过大"),
  strategy: z.enum(CONFLICT_STRATEGIES),
});

export async function confirmSubscriptionCsvImportAction(
  _prev: ImportActionResult | undefined,
  formData: FormData,
): Promise<ImportActionResult> {
  const session = await currentAppSession();
  if (!session) {
    return { ok: false, error: { code: "forbidden", message: "需要登录" } };
  }

  const parsed = ConfirmSchema.safeParse({
    csv: formData.get("csv") ?? "",
    strategy: formData.get("strategy") ?? "",
  });
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        code: "invalid_input",
        message: parsed.error.issues[0]?.message ?? "参数不合法",
      },
    };
  }

  try {
    const result = await executeSubscriptionImport(
      session.userId,
      parsed.data.csv,
      parsed.data.strategy,
    );
    revalidatePath("/subscriptions");
    revalidatePath("/settings/data");
    revalidatePath("/");
    return { ok: true, data: result };
  } catch (cause) {
    if (cause instanceof ImportError) {
      return { ok: false, error: { code: cause.code, message: cause.message } };
    }
    if (cause instanceof TenantError) {
      return { ok: false, error: { code: cause.code, message: cause.message } };
    }
    return { ok: false, error: { code: "server_error", message: "导入失败，请稍后重试" } };
  }
}


/* ---------- 邮件入站别名与原文保留（#58，design §7.5/§9） ---------- */

// 与 billing/subscription-actions 的 ActionResult<undefined> 同形，
// 可直接传给 ActionButton；清除数量只进审计日志，不回传客户端
export type InboundActionResult =
  | { ok: true; data?: undefined }
  | { ok: false; error: { code: string; message: string; fieldErrors?: Record<string, string[]> } };

function inboundActionError(cause: unknown): InboundActionResult {
  if (cause instanceof InboundAliasError) {
    return { ok: false, error: { code: cause.code, message: cause.message } };
  }
  return { ok: false, error: { code: "server_error", message: "操作失败，请稍后重试" } };
}

/** 生成或轮换别名：旧别名随提交立即失效；审计日志只记 userId（§9 脱敏）。 */
export async function rotateInboundAliasAction(
  _prev: InboundActionResult | undefined,
  _formData: FormData,
): Promise<InboundActionResult> {
  const session = await currentAppSession();
  if (!session) {
    return { ok: false, error: { code: "forbidden", message: "需要登录" } };
  }
  try {
    await rotateInboundAlias(session.userId);
    revalidatePath("/settings/data");
    return { ok: true };
  } catch (cause) {
    return inboundActionError(cause);
  }
}

/** 停用别名：入站地址立即失效，既有 InboundEmail 与草稿保留。 */
export async function revokeInboundAliasAction(
  _prev: InboundActionResult | undefined,
  _formData: FormData,
): Promise<InboundActionResult> {
  const session = await currentAppSession();
  if (!session) {
    return { ok: false, error: { code: "forbidden", message: "需要登录" } };
  }
  try {
    await revokeInboundAlias(session.userId);
    revalidatePath("/settings/data");
    return { ok: true };
  } catch (cause) {
    return inboundActionError(cause);
  }
}

/** 原文保留开关：关闭后新邮件不再保存原文；不动已存原文（用下面的立即清除）。 */
export async function setInboundRawRetentionAction(
  _prev: InboundActionResult | undefined,
  formData: FormData,
): Promise<InboundActionResult> {
  const session = await currentAppSession();
  if (!session) {
    return { ok: false, error: { code: "forbidden", message: "需要登录" } };
  }
  const retain = formData.get("retain") === "true";
  try {
    await setInboundRawRetention(session.userId, retain);
    revalidatePath("/settings/data");
    return { ok: true };
  } catch (cause) {
    return inboundActionError(cause);
  }
}

/** 立即清除当前用户全部已存邮件原文；行与元数据保留。 */
export async function clearInboundRawAction(
  _prev: InboundActionResult | undefined,
  _formData: FormData,
): Promise<InboundActionResult> {
  const session = await currentAppSession();
  if (!session) {
    return { ok: false, error: { code: "forbidden", message: "需要登录" } };
  }
  try {
    await clearInboundRawNow(session.userId);
    revalidatePath("/settings/data");
    return { ok: true };
  } catch (cause) {
    return inboundActionError(cause);
  }
}
