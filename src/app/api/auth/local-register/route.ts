import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { authModeGate, wantsHtmlRedirect } from "@/server/auth/auth-mode";
import { loadAppUrl } from "@/server/auth/config";
import { sendEmail } from "@/server/auth/email-sender";
import {
  clientIpFromRequest,
  emailRateLimitKey,
  isSameOriginAuthRequest,
} from "@/server/auth/http-security";
import { registerLocalUser, LocalAuthError } from "@/server/auth/local-auth";
import { issueEmailVerificationToken } from "@/server/auth/one-time-tokens";
import {
  consumeRateLimits,
  LOCAL_AUTH_RATE_LIMITS,
  withRateLimitKey,
} from "@/server/auth/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<NextResponse> {
  // 模式闸门（§7.1）：certus-only 部署下本地注册必须 404
  const gate = authModeGate("local");
  if (gate) return gate;

  if (!isSameOriginAuthRequest(request, loadAppUrl())) {
    return NextResponse.json(
      { ok: false, error: { code: "invalid_origin" } },
      { status: 403 },
    );
  }

  const form = await request.formData();
  const email = String(form.get("email") ?? "");
  const password = String(form.get("password") ?? "");
  const rateLimit = await consumeRateLimits([
    withRateLimitKey(LOCAL_AUTH_RATE_LIMITS.registerIp, clientIpFromRequest(request)),
    withRateLimitKey(LOCAL_AUTH_RATE_LIMITS.registerAccount, emailRateLimitKey(email)),
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

  const appUrl = loadAppUrl();
  try {
    const { userId } = await registerLocalUser({ email, password });
    // 注册即触发验证邮件（§7.1 M1b）；发信失败不拖垮注册——用户可稍后在
    // 登录页重新申请（request-verification）
    try {
      const token = await issueEmailVerificationToken(userId, email.trim().toLowerCase());
      await sendEmail({
        to: email.trim(),
        subject: "验证你的 conspectus 邮箱",
        text: `请打开以下链接验证邮箱（30 分钟内有效）：\n${appUrl.origin}/api/auth/verify-email?token=${token}`,
      });
    } catch (mailCause) {
      console.error(
        "[auth/local-register] verification email failed",
        mailCause instanceof Error ? mailCause.message : "unknown",
      );
    }
    if (wantsHtmlRedirect(request)) {
      return NextResponse.redirect(new URL("/login?registered=1", appUrl), 303);
    }
    return NextResponse.json({ ok: true, userId }, { status: 201 });
  } catch (cause) {
    if (cause instanceof LocalAuthError) {
      if (wantsHtmlRedirect(request) && cause.code !== "registration_disabled") {
        const target = new URL("/register", appUrl);
        target.searchParams.set("error", cause.code);
        return NextResponse.redirect(target, 303);
      }
      const status =
        cause.code === "registration_disabled"
          ? 404
          : cause.code === "email_taken"
            ? 409
            : 400;
      return NextResponse.json(
        { ok: false, error: { code: cause.code, message: cause.message } },
        { status },
      );
    }
    throw cause;
  }
}
