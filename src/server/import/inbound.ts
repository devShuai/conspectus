import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import { db } from "@/server/db";
import { encryptCredential, type CredentialKeyring } from "@/server/auth/crypto";

import { INBOUND_ALIAS_LOCAL_PART } from "./alias";

/**
 * Inbound Email API 的纯逻辑部分（#58，design §7.5/§8/§9）。
 *
 * 契约（与 #59 的 Cloudflare Email Worker 对齐）：
 * - POST application/json；body ≤ 1 MiB；
 * - 头 x-inbound-timestamp（epoch 毫秒）与 x-inbound-signature
 *   （HMAC-SHA256 hex，密钥 INBOUND_WEBHOOK_SECRET）；
 * - 签名消息与设备签名同构：method + path + timestamp + bodyHash 逐行拼接
 *   （design §6.2 的 canonical 形式），timestamp 容忍 5 分钟时钟窗；
 * - 重放由业务键 (userId, messageId) 唯一约束兜底：窗口内重放是幂等无写入。
 * - 危险内容在进入解析层前就被结构性地排除：API 只接受下述字段，附件/HTML
 *   没有对应字段可携带；raw MIME 加密落库仅供排查，解析层（#60）自行只抽取
 *   纯文本字段，绝不渲染 HTML 或拉取远程内容。
 */

export const INBOUND_PATH = "/api/inbound/email";
export const INBOUND_MAX_BODY_BYTES = 1024 * 1024;
export const INBOUND_TIMESTAMP_WINDOW_MS = 5 * 60 * 1000;
export const INBOUND_RAW_RETENTION_MS = 30 * 86_400_000;

export const inboundEmailPayloadSchema = z
  .object({
    messageId: z.string().trim().min(1).max(200),
    from: z.string().trim().min(1).max(320),
    to: z.string().trim().min(1).max(320),
    subject: z.string().max(500),
    receivedAt: z.iso.datetime(),
    /** RFC 822 原文（base64）；worker 侧已按大小上限截断/拒绝附件超限邮件 */
    raw: z.string().max(2 * 1024 * 1024).base64().optional(),
  })
  .strict(); // 不允许任何未声明字段（html/attachments/remote content 无入口）

export type InboundEmailPayload = z.infer<typeof inboundEmailPayloadSchema>;

export function inboundSignatureMessage(timestamp: string, bodyText: string): string {
  const bodyHash = createHash("sha256").update(bodyText).digest("hex");
  return ["POST", INBOUND_PATH, timestamp, bodyHash].join("\n");
}

export function signInboundRequest(
  secret: string,
  timestamp: string,
  bodyText: string,
): string {
  return createHmac("sha256", secret)
    .update(inboundSignatureMessage(timestamp, bodyText))
    .digest("hex");
}

/** 常量时间比较；长度不一直接判负（不泄露期望值长度以外的信息）。 */
export function verifyInboundSignature(
  secret: string,
  timestamp: string,
  bodyText: string,
  signatureHex: string,
): boolean {
  const expected = Buffer.from(signInboundRequest(secret, timestamp, bodyText), "utf8");
  const provided = Buffer.from(signatureHex, "utf8");
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}

/** 从收件地址提取别名本地部分并校验形态；不合法一律视为未知别名。 */
export function extractAliasLocalPart(to: string): string | null {
  const local = to.split("@")[0]?.trim().toLowerCase() ?? "";
  return INBOUND_ALIAS_LOCAL_PART.test(local) ? local : null;
}

export type RecordInboundResult = "created" | "duplicate";

/**
 * 落库一封已鉴权入站邮件。幂等：(userId, messageId) 唯一冲突即重复投递，
 * 返回 duplicate、零写入。用户关闭原文保留时 rawCipher/rawRetainedUntil 恒空
 * （DB CHECK 兜底）；保留期限从入站时刻起算 30 天。
 */
export async function recordInboundEmail(
  user: { id: string; inboundRetainRaw: boolean },
  payload: InboundEmailPayload,
  keyring: CredentialKeyring,
  now: Date = new Date(),
): Promise<RecordInboundResult> {
  // 与 DB CHECK 同源：rawCipher 非空 ⇔ rawRetainedUntil 非空
  const rawCipher =
    user.inboundRetainRaw && payload.raw !== undefined
      ? new Uint8Array(encryptCredential(Buffer.from(payload.raw, "base64"), keyring))
      : null;
  try {
    await db.inboundEmail.create({
      data: {
        userId: user.id,
        messageId: payload.messageId,
        fromAddr: payload.from,
        subject: payload.subject,
        receivedAt: new Date(payload.receivedAt),
        rawCipher,
        rawRetainedUntil: rawCipher
          ? new Date(now.getTime() + INBOUND_RAW_RETENTION_MS)
          : null,
      },
    });
    return "created";
  } catch (cause) {
    if (
      typeof cause === "object" &&
      cause !== null &&
      (cause as { code?: string }).code === "P2002"
    ) {
      return "duplicate";
    }
    throw cause;
  }
}
