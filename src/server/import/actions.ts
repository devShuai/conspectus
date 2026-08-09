"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { currentAppSession } from "@/server/auth/current-session";
import { TenantError } from "@/server/billing/subscriptions";
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
