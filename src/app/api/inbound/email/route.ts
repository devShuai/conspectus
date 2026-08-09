import { NextResponse } from "next/server";

import { db } from "@/server/db";
import { loadCredentialKeyring } from "@/server/auth/crypto";
import { clientIpFromRequest } from "@/server/auth/http-security";
import {
  INBOUND_RATE_LIMITS,
  consumeRateLimits,
  withRateLimitKey,
} from "@/server/auth/rate-limit";
import {
  INBOUND_MAX_BODY_BYTES,
  INBOUND_TIMESTAMP_WINDOW_MS,
  extractAliasLocalPart,
  inboundEmailPayloadSchema,
  recordInboundEmail,
  verifyInboundSignature,
} from "@/server/import/inbound";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/inbound/email — Cloudflare Email Worker 的入站 webhook（#58，
 * design §7.5/§8）。契约见 src/server/import/inbound.ts 头注。
 *
 * 响应纪律（#58 验收）：共享密钥/HMAC/时间窗失败返回明确 401 错误码；鉴权
 * 通过之后一律 202 { ok: true } —— 未知/旧别名、重复投递、正常落库从响应
 * 上不可区分，响应与日志都不泄露别名→用户映射、原文或 secret。所有响应
 * 带 Cache-Control: no-store（同 cron 契约 §5.4）。
 */
function inboundJson(data: unknown, init?: ResponseInit): NextResponse {
  const response = NextResponse.json(data, init);
  response.headers.set("Cache-Control", "no-store");
  return response;
}

function accepted(): NextResponse {
  return inboundJson({ ok: true }, { status: 202 });
}

/** 丢弃记录只写事件与类别，绝不写别名/地址/主题/正文（§9 日志脱敏）。 */
function auditDrop(reason: "unknown_alias" | "suspended_user"): void {
  console.log(JSON.stringify({ event: "inbound_email_dropped", reason }));
}

export async function POST(request: Request): Promise<NextResponse> {
  // 未配置共享密钥 = 功能未启用（§12.4）；与 deep ready 同约定返回 404
  const secret = process.env.INBOUND_WEBHOOK_SECRET?.trim();
  if (!secret) return inboundJson({ error: "not_found" }, { status: 404 });

  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    return inboundJson({ error: "unsupported_media_type" }, { status: 415 });
  }

  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (declaredLength > INBOUND_MAX_BODY_BYTES) {
    return inboundJson({ error: "payload_too_large" }, { status: 413 });
  }
  const bodyText = await request.text();
  if (Buffer.byteLength(bodyText, "utf8") > INBOUND_MAX_BODY_BYTES) {
    return inboundJson({ error: "payload_too_large" }, { status: 413 });
  }

  const timestamp = request.headers.get("x-inbound-timestamp") ?? "";
  const signature = request.headers.get("x-inbound-signature") ?? "";
  if (!timestamp || !signature) {
    return inboundJson({ error: "signature_required" }, { status: 401 });
  }
  const tsMs = Number(timestamp);
  if (
    !Number.isSafeInteger(tsMs) ||
    Math.abs(Date.now() - tsMs) > INBOUND_TIMESTAMP_WINDOW_MS
  ) {
    // 明确错误码（§6.2 时间窗约定）：调用方应校准时钟而不是笼统重试
    return inboundJson({ error: "stale_timestamp" }, { status: 401 });
  }
  if (!verifyInboundSignature(secret, timestamp, bodyText, signature)) {
    return inboundJson({ error: "invalid_signature" }, { status: 401 });
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(bodyText);
  } catch {
    return inboundJson({ error: "invalid_json" }, { status: 400 });
  }
  const payload = inboundEmailPayloadSchema.safeParse(parsedJson);
  if (!payload.success) {
    return inboundJson({ error: "invalid_payload" }, { status: 400 });
  }

  // §9：inbound 按 IP + 别名限流（计数在 PostgreSQL，多实例共享）。形态非法
  // 的收件地址共用 "invalid" 闸门；别名本地部分只以 sha256 指纹进计数表。
  const aliasLocal = extractAliasLocalPart(payload.data.to) ?? "invalid";
  const rateLimit = await consumeRateLimits([
    withRateLimitKey(INBOUND_RATE_LIMITS.emailIp, clientIpFromRequest(request)),
    withRateLimitKey(INBOUND_RATE_LIMITS.emailAlias, aliasLocal),
  ]);
  if (!rateLimit.allowed) {
    return inboundJson(
      { error: "rate_limited" },
      { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds) } },
    );
  }

  if (aliasLocal === "invalid") return accepted();

  const user = await db.user.findUnique({
    where: { inboundAddress: aliasLocal },
    select: { id: true, status: true, inboundRetainRaw: true },
  });
  if (!user) {
    auditDrop("unknown_alias");
    return accepted();
  }
  if (user.status === "suspended") {
    auditDrop("suspended_user");
    return accepted();
  }

  await recordInboundEmail(user, payload.data, loadCredentialKeyring());
  return accepted();
}
