import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { authModeGate, wantsHtmlRedirect } from "@/server/auth/auth-mode";
import { loadAppUrl } from "@/server/auth/config";
import { normalizeEmail } from "@/server/auth/email";
import { sendEmail } from "@/server/auth/email-sender";
import {
  clientIpFromRequest,
  isSameOriginAuthRequest,
  tokenRateLimitKey,
} from "@/server/auth/http-security";
import {
  consumePasswordResetToken,
  issuePasswordResetToken,
} from "@/server/auth/one-time-tokens";
import { hashPassword } from "@/server/auth/password";
import {
  consumeRateLimits,
  LOCAL_AUTH_RATE_LIMITS,
  withRateLimitKey,
} from "@/server/auth/rate-limit";
import { db } from "@/server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 找回密码（§7.1 M1b / #97）：
 * - 只带 email → 申请：签发一次性令牌并发邮件（账号枚举防护：永远 ok）
 * - 带 token + password → 确认：消费令牌改密并撤销全部会话
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  // 模式闸门（§7.1）：certus-only 部署下本地找回必须 404
  const gate = authModeGate("local");
  if (gate) return gate;

  const appUrl = loadAppUrl();
  if (!isSameOriginAuthRequest(request, appUrl)) {
    return NextResponse.json(
      { ok: false, error: { code: "invalid_origin" } },
      { status: 403 },
    );
  }

  const form = await request.formData();
  const email = String(form.get("email") ?? "");
  if (email && !form.get("token")) {
    return requestReset(request, appUrl, email);
  }

  const token = String(form.get("token") ?? "");
  const password = String(form.get("password") ?? "");
  const rateLimit = await consumeRateLimits([
    withRateLimitKey(LOCAL_AUTH_RATE_LIMITS.resetIp, clientIpFromRequest(request)),
    withRateLimitKey(LOCAL_AUTH_RATE_LIMITS.resetTarget, tokenRateLimitKey(token)),
  ]);
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { ok: false, error: { code: "rate_limited" } },
      {
        status: 429,
        headers: { "Retry-After": String(rateLimit.retryAfterSeconds) },
      },
    );
  }
  if (!token || password.length < 12) {
    return NextResponse.json(
      { ok: false, error: { code: "invalid_input" } },
      { status: 400 },
    );
  }
  try {
    const { userId } = await consumePasswordResetToken(token);
    const passwordHash = await hashPassword(password);
    await db.user.update({ where: { id: userId }, data: { passwordHash } });
    if (wantsHtmlRedirect(request)) {
      return NextResponse.redirect(new URL("/login?reset=ok", appUrl), 303);
    }
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch {
    if (wantsHtmlRedirect(request)) {
      return NextResponse.redirect(new URL("/reset-password?error=invalid_token", appUrl), 303);
    }
    return NextResponse.json(
      { ok: false, error: { code: "invalid_token" } },
      { status: 400 },
    );
  }
}

/** 申请分支：不论账号是否存在都返回 ok（防账号枚举），存在才发信。 */
async function requestReset(
  request: NextRequest,
  appUrl: URL,
  email: string,
): Promise<NextResponse> {
  const rateLimit = await consumeRateLimits([
    withRateLimitKey(LOCAL_AUTH_RATE_LIMITS.resetIp, clientIpFromRequest(request)),
  ]);
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { ok: false, error: { code: "rate_limited" } },
      {
        status: 429,
        headers: { "Retry-After": String(rateLimit.retryAfterSeconds) },
      },
    );
  }

  let normalized: string | null = null;
  try {
    normalized = normalizeEmail(email);
  } catch {
    normalized = null;
  }
  const user = normalized
    ? await db.user.findFirst({
        where: { email: normalized, passwordHash: { not: null } },
      })
    : null;
  if (user && normalized) {
    try {
      const token = await issuePasswordResetToken(user.id);
      await sendEmail({
        to: normalized,
        subject: "重置你的 conspectus 密码",
        text: `请打开以下链接重置密码（30 分钟内有效，完成后所有会话将失效）：\n${appUrl.origin}/reset-password?token=${token}`,
      });
    } catch (cause) {
      console.error(
        "[auth/password-reset] email failed",
        cause instanceof Error ? cause.message : "unknown",
      );
    }
  }

  if (wantsHtmlRedirect(request)) {
    return NextResponse.redirect(new URL("/reset-password?sent=1", appUrl), 303);
  }
  return NextResponse.json({ ok: true }, { status: 200 });
}
