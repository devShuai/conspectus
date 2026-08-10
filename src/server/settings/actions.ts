"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { db } from "@/server/db";
import { currentAppSession } from "@/server/auth/current-session";
import { isSupportedCurrency } from "@/server/billing/fx";
import { RebaseError, requestBaseCurrencyChange } from "@/server/billing/rebase";
import { seedDefaultNotificationRules } from "@/server/notify/seed";
import {
  NotificationAdminError,
  rotateWebhookSecret,
  saveChannel,
  saveRule,
  setChannelEnabled,
} from "@/server/notify/manage";
import { TenantError } from "@/server/billing/subscriptions";
import {
  ConnectionError,
  createProviderConnection,
  revokeProviderConnection,
} from "@/server/usage/connections";
import {
  BindingError,
  COLLECTOR_OPTIONS,
  createLocalBinding,
  createLocalCollectorSetup,
  deleteUsageMetric,
} from "@/server/usage/bindings";
import { AuthorityError, switchAuthoritativeBinding } from "@/server/usage/authority";
import { listBalanceAdapters } from "@/server/usage/providers/balance-adapters";
import {
  ManualUsageError,
  createManualQuota,
  updateManualUsage,
} from "@/server/usage/manual";

/**
 * Server Actions for the settings section (issue #71, design.md §8).
 * Fixed order: requireUser() -> Zod -> tenant-aware service -> write.
 */

export type ActionResult<T = undefined> =
  | { ok: true; data?: T }
  | { ok: false; error: { code: string; message: string; fieldErrors?: Record<string, string[]> } };

async function requireUser(): Promise<string> {
  const session = await currentAppSession();
  if (!session) throw new TenantError("forbidden", "authentication required");
  return session.userId;
}

function toFieldErrors(error: z.ZodError): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "_";
    (out[key] ??= []).push(issue.message);
  }
  return out;
}

const KNOWN_ERRORS: Array<{
  match: (cause: unknown) => string | null;
  message: (reason: string) => string;
}> = [
  {
    match: (c) => (c instanceof TenantError ? c.code : null),
    message: (r) => r,
  },
  {
    match: (c) => (c instanceof ConnectionError ? c.reason : null),
    message: (r) =>
      r === "unknown_provider"
        ? "不支持的服务商"
        : r === "connection_not_found"
          ? "连接不存在或已删除"
          : r === "subscription_not_found"
            ? "订阅不存在"
            : r,
  },
  {
    match: (c) => (c instanceof BindingError ? c.reason : null),
    message: (r) =>
      r === "unknown_collector"
        ? "未知的采集器"
        : r === "metric_prefix_mismatch"
          ? "指标需以该采集器的前缀开头（如 codex:tokens）"
          : r === "unsupported_metric"
            ? "该采集器不支持这个指标"
            : r === "metrics_required"
              ? "至少选择一个采集指标"
              : r === "metric_conflict"
                ? "已有同名额度的模型或单位与采集器不兼容"
                : r === "subscription_not_found"
                  ? "订阅不存在"
          : r === "quota_not_found"
            ? "额度不存在"
            : r,
  },
  {
    match: (c) => (c instanceof AuthorityError ? c.reason : null),
    message: (r) =>
      r === "quota_not_found"
        ? "额度不存在"
        : r === "binding_not_found"
          ? "来源不存在"
          : r === "binding_revoked"
            ? "已撤销的来源不能设为权威"
            : r,
  },
  {
    match: (c) => (c instanceof ManualUsageError ? c.reason : null),
    message: (r) =>
      r === "subscription_not_found"
        ? "订阅不存在"
        : r === "manual_binding_not_found"
          ? "该额度没有手动写入通道"
          : r === "quota_not_found"
            ? "额度不存在"
            : r,
  },
  {
    match: (c) => (c instanceof NotificationAdminError ? c.reason : null),
    message: (r) =>
      r === "webhook_digest_unsupported"
        ? "Webhook 渠道只支持逐条发送（每日摘要仅邮件渠道）"
        : r === "destination_required"
          ? "Webhook 渠道需要目标 URL"
          : r === "destination_webhook_only"
            ? "目标 URL 仅 Webhook 渠道使用"
            : r === "channel_not_found"
              ? "渠道不存在或已删除"
              : r === "channel_type_immutable"
                ? "渠道类型不可修改"
                : r === "secret_webhook_only"
                  ? "仅 Webhook 渠道有签名密钥"
                  : r === "rule_not_found"
                    ? "规则不存在"
                    : r === "rule_type_immutable"
                      ? "规则类型不可修改"
                      : r === "subscription_not_found"
                        ? "订阅不存在"
                        : r === "digest_time_email_only"
                          ? "摘要时刻仅邮件渠道可设置"
                          : r === "invalid_digest_time"
                            ? "摘要时刻需为 HH:MM（24 小时制）"
                            : r === "invalid_rule_config"
                              ? "规则配置不合法，请检查阈值格式"
                              : r,
  },
];

function toActionError(cause: unknown): ActionResult {
  for (const known of KNOWN_ERRORS) {
    const reason = known.match(cause);
    if (reason !== null) {
      return { ok: false, error: { code: reason, message: known.message(reason) } };
    }
  }
  return { ok: false, error: { code: "server_error", message: "操作失败，请稍后重试" } };
}

/* ---------- 时区 ---------- */

const TimezoneSchema = z.object({
  timezone: z
    .string()
    .trim()
    .min(1, "时区不能为空")
    .max(64)
    .refine((tz) => {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    }, "无效的 IANA 时区"),
});

export async function updateTimezone(
  prev: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const userId = await requireUser();
    const parsed = TimezoneSchema.safeParse({ timezone: formData.get("timezone") ?? "" });
    if (!parsed.success) {
      return { ok: false, error: { code: "validation", message: "请检查输入", fieldErrors: toFieldErrors(parsed.error) } };
    }
    await db.user.update({
      where: { id: userId },
      data: { timezone: parsed.data.timezone },
    });
    revalidatePath("/settings");
    return { ok: true };
  } catch (cause) {
    return toActionError(cause);
  }
}

/* ---------- 本位币变更（异步 rebase） ---------- */

const RebaseSchema = z.object({
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/, "币种需为 3 位 ISO-4217 代码")
    .refine(isSupportedCurrency, "汇率源暂不覆盖该币种"),
});

export async function requestRebase(
  prev: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const userId = await requireUser();
    const parsed = RebaseSchema.safeParse({ currency: formData.get("currency") ?? "" });
    if (!parsed.success) {
      return { ok: false, error: { code: "validation", message: "请检查输入", fieldErrors: toFieldErrors(parsed.error) } };
    }
    await requestBaseCurrencyChange({ userId, toCurrency: parsed.data.currency });
    revalidatePath("/settings");
    return { ok: true };
  } catch (cause) {
    if (cause instanceof RebaseError) {
      const messages: Record<string, string> = {
        same_currency: "该币种已是当前本位币",
        job_in_flight: "已有进行中的变更，请等待完成",
      };
      return {
        ok: false,
        error: { code: cause.reason, message: messages[cause.reason] ?? "操作失败，请稍后重试" },
      };
    }
    return toActionError(cause);
  }
}

export async function retryRebase(
  prev: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const userId = await requireUser();
    const jobId = String(formData.get("jobId") ?? "");
    const result = await db.currencyRebaseJob.updateMany({
      where: { id: jobId, userId, status: "failed" },
      data: { status: "pending", lastError: null },
    });
    if (result.count !== 1) {
      return { ok: false, error: { code: "job_not_found", message: "任务不存在或不处于失败状态" } };
    }
    revalidatePath("/settings");
    return { ok: true };
  } catch (cause) {
    return toActionError(cause);
  }
}

/* ---------- 服务商连接 ---------- */

const ConnectProviderSchema = z.object({
  providerId: z
    .string()
    .trim()
    .min(1, "请选择服务商")
    .refine((id) => listBalanceAdapters().some((p) => p.id === id), "不支持的服务商"),
  displayName: z.string().trim().min(1, "显示名不能为空").max(60),
  apiKey: z.string().trim().min(8, "API Key 至少 8 位").max(512),
  subscriptionId: z.string().trim().min(1, "请选择订阅"),
  unit: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/, "余额币种需为 3 位 ISO-4217 代码"),
  scopes: z
    .string()
    .trim()
    .transform((v) => (v === "" ? [] : v.split(/[,\s]+/).filter(Boolean))),
});

export async function connectProviderAction(
  prev: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const userId = await requireUser();
    const parsed = ConnectProviderSchema.safeParse({
      providerId: formData.get("providerId") ?? "",
      displayName: formData.get("displayName") ?? "",
      apiKey: formData.get("apiKey") ?? "",
      subscriptionId: formData.get("subscriptionId") ?? "",
      unit: formData.get("unit") ?? "CNY",
      scopes: formData.get("scopes") ?? "",
    });
    if (!parsed.success) {
      return { ok: false, error: { code: "validation", message: "请检查输入", fieldErrors: toFieldErrors(parsed.error) } };
    }
    await createProviderConnection({ userId, ...parsed.data });
    revalidatePath("/settings/connections");
    revalidatePath("/usage");
    return { ok: true };
  } catch (cause) {
    return toActionError(cause);
  }
}

export async function disconnectProviderAction(
  prev: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const userId = await requireUser();
    const connectionId = String(formData.get("connectionId") ?? "");
    await revokeProviderConnection({ userId, connectionId });
    revalidatePath("/settings/connections");
    return { ok: true };
  } catch (cause) {
    return toActionError(cause);
  }
}

/* ---------- 手动录入用量 ---------- */

const optionalNumber = z
  .string()
  .trim()
  .transform((v) => (v === "" ? undefined : Number(v)))
  .refine((v) => v === undefined || Number.isFinite(v), "需为数字");

const ManualQuotaSchema = z
  .object({
    subscriptionId: z.string().trim().min(1, "请选择订阅"),
    kind: z.enum(["quota", "balance", "counter"]),
    metric: z.string().trim().min(1, "指标不能为空").max(60),
    unit: z.string().trim().min(1, "单位不能为空").max(20),
    limitValue: optionalNumber,
    usedValue: optionalNumber,
    remainingValue: optionalNumber,
    resetCycle: z.enum(["daily", "weekly", "monthly", "billing_cycle", "never"]),
  })
  .superRefine((value, ctx) => {
    if (value.kind === "quota" && value.limitValue === undefined) {
      ctx.addIssue({ code: "custom", path: ["limitValue"], message: "quota 需要上限" });
    }
    if ((value.kind === "quota" || value.kind === "counter") && value.usedValue === undefined) {
      ctx.addIssue({ code: "custom", path: ["usedValue"], message: "请填写当前已用值（可填 0）" });
    }
    if (value.kind === "balance" && value.remainingValue === undefined) {
      ctx.addIssue({ code: "custom", path: ["remainingValue"], message: "balance 需要剩余值" });
    }
    if (value.kind === "balance" && value.resetCycle !== "never") {
      ctx.addIssue({ code: "custom", path: ["resetCycle"], message: "balance 的周期恒为 never" });
    }
  });

export async function createManualQuotaAction(
  prev: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const userId = await requireUser();
    const parsed = ManualQuotaSchema.safeParse({
      subscriptionId: formData.get("subscriptionId") ?? "",
      kind: formData.get("kind") ?? "quota",
      metric: formData.get("metric") ?? "",
      unit: formData.get("unit") ?? "",
      limitValue: formData.get("limitValue") ?? "",
      usedValue: formData.get("usedValue") ?? "",
      remainingValue: formData.get("remainingValue") ?? "",
      resetCycle: formData.get("resetCycle") ?? "monthly",
    });
    if (!parsed.success) {
      return { ok: false, error: { code: "validation", message: "请检查输入", fieldErrors: toFieldErrors(parsed.error) } };
    }
    const { subscriptionId, kind, metric, unit, limitValue, usedValue, remainingValue, resetCycle } =
      parsed.data;
    const now = new Date();
    await createManualQuota({
      userId,
      subscriptionId,
      kind,
      metric,
      unit,
      limitValue,
      usedValue,
      remainingValue,
      resetCycle,
      ...(kind === "quota" ? { periodStart: now, periodEnd: nextPeriodEnd(now, resetCycle) } : {}),
    });
    revalidatePath("/settings/usage");
    revalidatePath("/usage");
    return { ok: true };
  } catch (cause) {
    return toActionError(cause);
  }
}

/** quota 需要 period；按 resetCycle 估算一个初始周期（数据源的读数到达后以数据源为准）。 */
function nextPeriodEnd(from: Date, cycle: "daily" | "weekly" | "monthly" | "billing_cycle" | "never"): Date {
  const end = new Date(from);
  if (cycle === "daily") end.setDate(end.getDate() + 1);
  else if (cycle === "weekly") end.setDate(end.getDate() + 7);
  else end.setMonth(end.getMonth() + 1); // monthly / billing_cycle / never 暂按月
  return end;
}

const ManualUsageSchema = z.object({
  quotaId: z.string().trim().min(1),
  usedValue: optionalNumber,
  remainingValue: optionalNumber,
});

export async function updateManualUsageAction(
  prev: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const userId = await requireUser();
    const parsed = ManualUsageSchema.safeParse({
      quotaId: formData.get("quotaId") ?? "",
      usedValue: formData.get("usedValue") ?? "",
      remainingValue: formData.get("remainingValue") ?? "",
    });
    if (!parsed.success) {
      return { ok: false, error: { code: "validation", message: "请检查输入", fieldErrors: toFieldErrors(parsed.error) } };
    }
    if (parsed.data.usedValue === undefined && parsed.data.remainingValue === undefined) {
      return { ok: false, error: { code: "validation", message: "至少填写一个读数" } };
    }
    await updateManualUsage({ userId, ...parsed.data });
    revalidatePath("/settings/usage");
    revalidatePath("/usage");
    return { ok: true };
  } catch (cause) {
    return toActionError(cause);
  }
}

/* ---------- 本地采集绑定 ---------- */

const LocalBindingSchema = z.object({
  quotaId: z.string().trim().min(1, "缺少额度"),
  collectorId: z
    .string()
    .trim()
    .refine((id) => COLLECTOR_OPTIONS.some((c) => c.id === id), "未知的采集器"),
  metric: z.string().trim().min(1, "指标不能为空").max(60),
});

export async function createLocalBindingAction(
  prev: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const userId = await requireUser();
    const parsed = LocalBindingSchema.safeParse({
      quotaId: formData.get("quotaId") ?? "",
      collectorId: formData.get("collectorId") ?? "",
      metric: formData.get("metric") ?? "",
    });
    if (!parsed.success) {
      return { ok: false, error: { code: "validation", message: "请检查输入", fieldErrors: toFieldErrors(parsed.error) } };
    }
    await createLocalBinding({ userId, ...parsed.data });
    revalidatePath("/settings/usage");
    revalidatePath("/usage");
    return { ok: true };
  } catch (cause) {
    return toActionError(cause);
  }
}

const LocalCollectorSetupSchema = z.object({
  subscriptionId: z.string().trim().min(1, "请选择订阅"),
  collectorId: z
    .string()
    .trim()
    .refine((id) => COLLECTOR_OPTIONS.some((collector) => collector.id === id), "未知的采集器"),
  metrics: z.array(z.string().trim()).min(1, "至少选择一个指标").max(4),
});

export async function createLocalCollectorSetupAction(
  prev: ActionResult<{ created: number; authorityNeedsConfirmation: number }> | undefined,
  formData: FormData,
): Promise<ActionResult<{ created: number; authorityNeedsConfirmation: number }>> {
  try {
    const userId = await requireUser();
    const parsed = LocalCollectorSetupSchema.safeParse({
      subscriptionId: formData.get("subscriptionId") ?? "",
      collectorId: formData.get("collectorId") ?? "",
      metrics: formData.getAll("metrics"),
    });
    if (!parsed.success) {
      return { ok: false, error: { code: "validation", message: "请检查输入", fieldErrors: toFieldErrors(parsed.error) } };
    }
    const result = await createLocalCollectorSetup({ userId, ...parsed.data });
    revalidatePath("/settings/usage");
    revalidatePath("/usage");
    return { ok: true, data: result };
  } catch (cause) {
    return toActionError(cause);
  }
}

const SwitchAuthoritySchema = z.object({
  quotaId: z.string().uuid(),
  bindingId: z.string().uuid(),
});

export async function switchUsageAuthorityAction(
  prev: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const userId = await requireUser();
    const parsed = SwitchAuthoritySchema.safeParse({
      quotaId: formData.get("quotaId") ?? "",
      bindingId: formData.get("bindingId") ?? "",
    });
    if (!parsed.success) {
      return { ok: false, error: { code: "validation", message: "来源参数无效" } };
    }
    await switchAuthoritativeBinding({ userId, quotaId: parsed.data.quotaId, newBindingId: parsed.data.bindingId });
    revalidatePath("/settings/usage");
    revalidatePath("/usage");
    return { ok: true };
  } catch (cause) {
    return toActionError(cause);
  }
}

const DeleteUsageMetricSchema = z.object({
  quotaId: z.string().uuid(),
});

export async function deleteUsageMetricAction(
  prev: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  void prev;
  try {
    const userId = await requireUser();
    const parsed = DeleteUsageMetricSchema.safeParse({
      quotaId: formData.get("quotaId") ?? "",
    });
    if (!parsed.success) {
      return { ok: false, error: { code: "validation", message: "指标参数无效" } };
    }
    await deleteUsageMetric({ userId, quotaId: parsed.data.quotaId });
    revalidatePath("/settings/usage");
    revalidatePath("/usage");
    revalidatePath("/analytics");
    revalidatePath("/");
    return { ok: true };
  } catch (cause) {
    return toActionError(cause);
  }
}

/* ---------- 采集设备 ---------- */

export async function revokeDeviceAction(
  prev: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const userId = await requireUser();
    const deviceId = String(formData.get("deviceId") ?? "");
    const result = await db.collectorDevice.updateMany({
      where: { id: deviceId, userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (result.count !== 1) {
      return { ok: false, error: { code: "device_not_found", message: "设备不存在或已撤销" } };
    }
    revalidatePath("/settings/devices");
    return { ok: true };
  } catch (cause) {
    return toActionError(cause);
  }
}

/* ---------- 通知默认规则 ---------- */

export async function seedNotificationRulesAction(
  prev: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const userId = await requireUser();
    void formData;
    const created = await seedDefaultNotificationRules(userId);
    void created;
    revalidatePath("/settings/notifications");
    return { ok: true };
  } catch (cause) {
    return toActionError(cause);
  }
}

/* ---------- 通知渠道与规则管理（#115，design §7.6/§8） ---------- */

const NotificationChannelSchema = z.object({
  channelId: z.string().trim().min(1).optional(),
  type: z.enum(["email", "webhook"]),
  mode: z.enum(["individual", "daily_digest"]).default("individual"),
  destination: z
    .string()
    .trim()
    .max(2048)
    .refine(
      (v) => {
        if (v === "") return true;
        try {
          const url = new URL(v);
          return url.protocol === "https:" || url.protocol === "http:";
        } catch {
          return false;
        }
      },
      "目标 URL 需为 http(s) 地址",
    )
    .optional(),
  enabled: z.enum(["true", "false"]).optional(),
  digestLocalTime: z
    .string()
    .trim()
    .regex(/^$|^([01]\d|2[0-3]):[0-5]\d$/, "摘要时刻需为 HH:MM（24 小时制）")
    .optional(),
});

export type SaveChannelResult = ActionResult<{
  enabled: boolean;
  verified: boolean | null;
}>;

export async function saveNotificationChannel(
  prev: SaveChannelResult | undefined,
  formData: FormData,
): Promise<SaveChannelResult> {
  try {
    const userId = await requireUser();
    const parsed = NotificationChannelSchema.safeParse({
      channelId: String(formData.get("channelId") ?? "") || undefined,
      type: formData.get("type") ?? "",
      mode: formData.get("mode") ?? "individual",
      destination: String(formData.get("destination") ?? "") || undefined,
      enabled: formData.get("enabled") ?? undefined,
      digestLocalTime: String(formData.get("digestLocalTime") ?? "") || undefined,
    });
    if (!parsed.success) {
      return { ok: false, error: { code: "validation", message: "请检查输入", fieldErrors: toFieldErrors(parsed.error) } };
    }
    const result = await saveChannel({
      userId,
      channelId: parsed.data.channelId,
      type: parsed.data.type,
      mode: parsed.data.mode,
      destination: parsed.data.destination,
      digestLocalTime: parsed.data.digestLocalTime,
      enabled:
        parsed.data.enabled === undefined ? undefined : parsed.data.enabled === "true",
    });
    revalidatePath("/settings/notifications");
    return { ok: true, data: { enabled: result.enabled, verified: result.verified } };
  } catch (cause) {
    return toActionError(cause);
  }
}

/** 轮换 webhook 签名密钥：旧签名立即失效（§7.6）。 */
export async function rotateNotificationChannelSecret(
  prev: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const userId = await requireUser();
    const channelId = String(formData.get("channelId") ?? "");
    await rotateWebhookSecret({ userId, channelId });
    revalidatePath("/settings/notifications");
    return { ok: true };
  } catch (cause) {
    return toActionError(cause);
  }
}

/** 渠道启停（#115）：启用 webhook 会先跑验证性 POST，未通过保持停用并报错。 */
export async function setNotificationChannelEnabled(
  prev: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const userId = await requireUser();
    const channelId = String(formData.get("channelId") ?? "");
    const enabled = String(formData.get("enabled") ?? "") === "true";
    const result = await setChannelEnabled({ userId, channelId, enabled });
    revalidatePath("/settings/notifications");
    if (enabled && result.verified === false) {
      return {
        ok: false,
        error: { code: "verify_failed", message: "验证性 POST 未通过，渠道保持停用；修复目标后重试" },
      };
    }
    return { ok: true };
  } catch (cause) {
    return toActionError(cause);
  }
}

const intList = z
  .string()
  .trim()
  .transform((v) =>
    v === "" ? [] : v.split(/[,\s]+/).filter(Boolean).map(Number).filter(Number.isFinite),
  );

const NotificationRuleSchema = z.object({
  ruleId: z.string().trim().min(1).optional(),
  type: z.enum([
    "renewal_due",
    "trial_ending",
    "usage_threshold",
    "balance_low",
    "collector_stale",
    "price_change",
    "connection_failed",
  ]),
  subscriptionId: z.string().trim().min(1).optional(),
  enabled: z.enum(["true", "false"]).optional(),
  daysBefore: intList.optional(),
  percent: intList.optional(),
  minValue: optionalNumber,
  minDaysLeft: optionalNumber,
  days: optionalNumber,
});

export async function saveNotificationRule(
  prev: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const userId = await requireUser();
    const parsed = NotificationRuleSchema.safeParse({
      ruleId: String(formData.get("ruleId") ?? "") || undefined,
      type: formData.get("type") ?? "",
      subscriptionId: String(formData.get("subscriptionId") ?? "") || undefined,
      enabled: formData.get("enabled") ?? undefined,
      daysBefore: formData.get("daysBefore") ?? undefined,
      percent: formData.get("percent") ?? undefined,
      minValue: formData.get("minValue") ?? "",
      minDaysLeft: formData.get("minDaysLeft") ?? "",
      days: formData.get("days") ?? "",
    });
    if (!parsed.success) {
      return { ok: false, error: { code: "validation", message: "请检查输入", fieldErrors: toFieldErrors(parsed.error) } };
    }
    const { ruleId, type, subscriptionId, enabled, daysBefore, percent, minValue, minDaysLeft, days } =
      parsed.data;
    // 启停开关（ActionButton）不带任何配置字段 → 保留原配置
    const hasConfig =
      daysBefore !== undefined ||
      percent !== undefined ||
      minValue !== undefined ||
      minDaysLeft !== undefined ||
      days !== undefined;
    await saveRule({
      userId,
      ruleId,
      type,
      subscriptionId,
      enabled: enabled === undefined ? undefined : enabled === "true",
      ...(hasConfig
        ? {
            config: {
              ...(daysBefore?.length ? { daysBefore } : {}),
              ...(percent?.length ? { percent } : {}),
              ...(minValue !== undefined ? { minValue } : {}),
              ...(minDaysLeft !== undefined ? { minDaysLeft } : {}),
              ...(days !== undefined ? { days } : {}),
            },
          }
        : {}),
    });
    revalidatePath("/settings/notifications");
    return { ok: true };
  } catch (cause) {
    return toActionError(cause);
  }
}
