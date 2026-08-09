import { randomBytes } from "node:crypto";

import type { Prisma } from "@prisma/client";

import { db } from "@/server/db";
import {
  decryptCredential,
  encryptCredential,
  loadCredentialKeyring,
} from "@/server/auth/crypto";
import { toStoredBytes } from "@/server/auth/session-db";

import type { RuleConfig } from "./scan";
import { postSafeWebhook } from "./webhook-safe";
import { webhookHeaders } from "./webhook-signing";

/**
 * 通知渠道与规则的管理服务（#115，design §7.6 渠道模型 / §8 Actions）。
 * Server Action 只做 requireUser + Zod，所有权与领域规则都在这里。
 */

export class NotificationAdminError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "NotificationAdminError";
  }
}

export type ChannelType = "email" | "webhook";
export type ChannelMode = "individual" | "daily_digest";

const RULE_TYPES = [
  "renewal_due",
  "trial_ending",
  "usage_threshold",
  "balance_low",
  "collector_stale",
  "price_change",
  "connection_failed",
] as const;
export type RuleType = (typeof RULE_TYPES)[number];

export function generateWebhookSecret(): string {
  return randomBytes(32).toString("base64url");
}

/** "HH:MM" → @db.Time 载体（1970-01-01 UTC）；非法格式抛 invalid_digest_time。 */
export function parseDigestLocalTime(raw: string): Date {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(raw.trim());
  if (!match) throw new NotificationAdminError("invalid_digest_time");
  return new Date(Date.UTC(1970, 0, 1, Number(match[1]), Number(match[2])));
}

function encryptSecret(secret: string): Uint8Array<ArrayBuffer> {
  return toStoredBytes(
    encryptCredential(Buffer.from(secret, "utf8"), loadCredentialKeyring()),
  );
}

/** 密钥用户可见（§7.6）：页面服务端解密回显；keyring 不可用时静默为空。 */
export function readWebhookSecret(secretCipher: Uint8Array | null): string | null {
  if (!secretCipher) return null;
  try {
    return decryptCredential(secretCipher, loadCredentialKeyring()).toString("utf8");
  } catch {
    return null;
  }
}

/** 带签名的验证性 POST（§7.6/§9）：走 #103 修复后的 SSRF 防护路径。 */
export async function verifyWebhookDestination(input: {
  channelId: string;
  destination: string;
  secretCipher: Uint8Array;
  now?: Date;
}): Promise<boolean> {
  const now = input.now ?? new Date();
  const body = JSON.stringify({
    id: `evt_verify_${input.channelId}`,
    event: "webhook_verify",
    occurredAt: now.toISOString(),
    data: { channelId: input.channelId },
  });
  return postSafeWebhook(input.destination, {
    headers: webhookHeaders(`evt_verify_${input.channelId}`, body, input.secretCipher, now),
    body,
  });
}

/**
 * 创建/更新渠道。约束（§7.6）：destination 仅 webhook 使用且必填；
 * daily_digest（及 #116 的 digestLocalTime）只允许 email，webhook 强制 individual。
 * webhook 保存时做带签名验证性 POST，未通过落 enabled=false；显式停用不验证。
 */
export async function saveChannel(input: {
  userId: string;
  channelId?: string;
  type: ChannelType;
  mode: ChannelMode;
  destination?: string;
  digestLocalTime?: string;
  enabled?: boolean;
  now?: Date;
}): Promise<{ channelId: string; enabled: boolean; verified: boolean | null }> {
  const destination = input.destination?.trim() || undefined;
  const digestTimeRaw = input.digestLocalTime?.trim() || undefined;
  if (input.type === "webhook") {
    if (input.mode === "daily_digest") {
      throw new NotificationAdminError("webhook_digest_unsupported");
    }
    if (!destination) throw new NotificationAdminError("destination_required");
    // §7.6：daily_digest / digestLocalTime 只允许 email
    if (digestTimeRaw) throw new NotificationAdminError("digest_time_email_only");
  } else if (destination) {
    throw new NotificationAdminError("destination_webhook_only");
  }
  const digestLocalTime = digestTimeRaw ? parseDigestLocalTime(digestTimeRaw) : null;

  if (!input.channelId) {
    if (input.type === "email") {
      const channel = await db.notificationChannel.create({
        data: {
          userId: input.userId,
          type: "email",
          mode: input.mode,
          digestLocalTime,
          enabled: input.enabled ?? true,
        },
      });
      return { channelId: channel.id, enabled: channel.enabled, verified: null };
    }
    const secretCipher = encryptSecret(generateWebhookSecret());
    const channel = await db.notificationChannel.create({
      data: {
        userId: input.userId,
        type: "webhook",
        mode: "individual",
        destination,
        secretCipher,
        enabled: false,
      },
    });
    if (input.enabled === false) {
      return { channelId: channel.id, enabled: false, verified: null };
    }
    const verified = await verifyWebhookDestination({
      channelId: channel.id,
      destination: destination!,
      secretCipher,
      now: input.now,
    });
    if (verified) {
      await db.notificationChannel.update({
        where: { id: channel.id },
        data: { enabled: true },
      });
    }
    return { channelId: channel.id, enabled: verified, verified };
  }

  const existing = await db.notificationChannel.findFirst({
    where: { id: input.channelId, userId: input.userId },
  });
  if (!existing) throw new NotificationAdminError("channel_not_found");
  if (existing.type !== input.type) {
    throw new NotificationAdminError("channel_type_immutable");
  }

  let verified: boolean | null = null;
  let enabled = input.enabled ?? existing.enabled;
  let secretCipher: Uint8Array<ArrayBuffer> | null = existing.secretCipher
    ? toStoredBytes(Buffer.from(existing.secretCipher))
    : null;
  if (input.type === "webhook") {
    // 早期测试建行可能没有密钥：保存时补发，保证签名三件套始终可用
    if (!secretCipher) secretCipher = encryptSecret(generateWebhookSecret());
    if (enabled) {
      verified = await verifyWebhookDestination({
        channelId: existing.id,
        destination: destination!,
        secretCipher,
        now: input.now,
      });
      enabled = verified;
    }
  }

  await db.notificationChannel.update({
    where: { id: existing.id },
    data: {
      mode: input.mode,
      destination: destination ?? null,
      // email 渠道：表单总是提交该字段（空 = 默认 09:00）；webhook 恒为 null
      digestLocalTime: input.type === "email" ? digestLocalTime : null,
      secretCipher,
      enabled,
    },
  });
  return { channelId: existing.id, enabled, verified };
}

/**
 * 轮换 webhook 密钥（§7.6）：写 secretCipher（§9 envelope），签名读取当前值，
 * 覆盖即旧签名立即失效。
 */
export async function rotateWebhookSecret(input: {
  userId: string;
  channelId: string;
}): Promise<void> {
  const channel = await db.notificationChannel.findFirst({
    where: { id: input.channelId, userId: input.userId },
  });
  if (!channel) throw new NotificationAdminError("channel_not_found");
  if (channel.type !== "webhook") {
    throw new NotificationAdminError("secret_webhook_only");
  }
  await db.notificationChannel.update({
    where: { id: channel.id },
    data: { secretCipher: encryptSecret(generateWebhookSecret()) },
  });
}

/**
 * 启停开关（#115）：停用直接落 enabled=false；启用 webhook 需先通过带签名的
 * 验证性 POST，未通过保持停用（verified=false 由 Action 转成用户可见错误）。
 */
export async function setChannelEnabled(input: {
  userId: string;
  channelId: string;
  enabled: boolean;
  now?: Date;
}): Promise<{ enabled: boolean; verified: boolean | null }> {
  const channel = await db.notificationChannel.findFirst({
    where: { id: input.channelId, userId: input.userId },
  });
  if (!channel) throw new NotificationAdminError("channel_not_found");

  if (!input.enabled) {
    await db.notificationChannel.update({
      where: { id: channel.id },
      data: { enabled: false },
    });
    return { enabled: false, verified: null };
  }
  if (channel.type === "webhook") {
    if (!channel.destination) throw new NotificationAdminError("destination_required");
    const secretCipher = channel.secretCipher
      ? toStoredBytes(Buffer.from(channel.secretCipher))
      : encryptSecret(generateWebhookSecret());
    const verified = await verifyWebhookDestination({
      channelId: channel.id,
      destination: channel.destination,
      secretCipher,
      now: input.now,
    });
    await db.notificationChannel.update({
      where: { id: channel.id },
      data: { enabled: verified, secretCipher },
    });
    return { enabled: verified, verified };
  }
  await db.notificationChannel.update({
    where: { id: channel.id },
    data: { enabled: true },
  });
  return { enabled: true, verified: null };
}

/** 按规则类型归一化 config（§7.6 规则模型）；语义不合法抛 invalid_rule_config。 */
export function normalizeRuleConfig(type: RuleType, raw: RuleConfig): RuleConfig {
  const ints = (values: number[] | undefined, min: number, max: number) =>
    Array.isArray(values) &&
    values.length > 0 &&
    values.every((v) => Number.isInteger(v) && v >= min && v <= max);

  switch (type) {
    case "renewal_due":
    case "trial_ending":
      if (!ints(raw.daysBefore, 0, 365)) throw new NotificationAdminError("invalid_rule_config");
      return { daysBefore: [...new Set(raw.daysBefore)].sort((a, b) => b - a) };
    case "usage_threshold":
      if (!ints(raw.percent, 1, 100)) throw new NotificationAdminError("invalid_rule_config");
      return { percent: [...new Set(raw.percent)].sort((a, b) => a - b) };
    case "balance_low": {
      const minValue = raw.minValue;
      const minDaysLeft = raw.minDaysLeft;
      const okValue = typeof minValue === "number" && Number.isFinite(minValue) && minValue > 0;
      const okDays = typeof minDaysLeft === "number" && Number.isInteger(minDaysLeft) && minDaysLeft > 0;
      if (!okValue && !okDays) throw new NotificationAdminError("invalid_rule_config");
      return {
        ...(okValue ? { minValue } : {}),
        ...(okDays ? { minDaysLeft } : {}),
      };
    }
    case "collector_stale": {
      const days = raw.days ?? 3;
      if (!Number.isInteger(days) || days < 1 || days > 365) {
        throw new NotificationAdminError("invalid_rule_config");
      }
      return { days };
    }
    case "price_change":
    case "connection_failed":
      return {};
    default:
      throw new NotificationAdminError("invalid_rule_config");
  }
}

/**
 * 创建/更新规则。「删除」落 enabled=false 保留投递审计（§7.6），由调用方传
 * enabled:false；update 不传 config 表示保留原配置（启停开关路径）。
 */
export async function saveRule(input: {
  userId: string;
  ruleId?: string;
  type: RuleType;
  config?: RuleConfig;
  subscriptionId?: string;
  enabled?: boolean;
}): Promise<{ ruleId: string }> {
  if (input.subscriptionId) {
    const subscription = await db.subscription.findFirst({
      where: { id: input.subscriptionId, userId: input.userId },
      select: { id: true },
    });
    if (!subscription) throw new NotificationAdminError("subscription_not_found");
  }

  if (input.ruleId) {
    const existing = await db.notificationRule.findFirst({
      where: { id: input.ruleId, userId: input.userId },
    });
    if (!existing) throw new NotificationAdminError("rule_not_found");
    if (existing.type !== input.type) {
      throw new NotificationAdminError("rule_type_immutable");
    }
    await db.notificationRule.update({
      where: { id: existing.id },
      data: {
        ...(input.config !== undefined
          ? { config: normalizeRuleConfig(input.type, input.config) as Prisma.InputJsonValue }
          : {}),
        subscriptionId: input.subscriptionId ?? null,
        enabled: input.enabled ?? existing.enabled,
      },
    });
    return { ruleId: existing.id };
  }

  if (input.config === undefined) throw new NotificationAdminError("invalid_rule_config");
  const rule = await db.notificationRule.create({
    data: {
      userId: input.userId,
      type: input.type,
      config: normalizeRuleConfig(input.type, input.config) as Prisma.InputJsonValue,
      subscriptionId: input.subscriptionId ?? null,
      enabled: input.enabled ?? true,
    },
  });
  return { ruleId: rule.id };
}

/**
 * 邮箱投递门禁的三态展示（§7.6「渠道层面展示真实原因」，#115/#116）：
 * 本地未验证 → 去验证邮箱；certus 未验证 → 认证中心重发验证；快照陈旧 → 重新登录。
 */
export type EmailGateState =
  | "no_email"
  | "verified"
  | "local_unverified"
  | "certus_unverified"
  | "snapshot_stale";

export function emailGateState(user: {
  email: string | null;
  emailVerifiedAt: Date | null;
  emailSyncRequiredAt: Date | null;
  passwordHash: string | null;
}): EmailGateState {
  if (!user.email) return "no_email";
  if (user.emailSyncRequiredAt) return "snapshot_stale";
  if (user.emailVerifiedAt) return "verified";
  return user.passwordHash ? "local_unverified" : "certus_unverified";
}
