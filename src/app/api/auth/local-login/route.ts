import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { authModeGate, wantsHtmlRedirect } from "@/server/auth/auth-mode";
import { SESSION_COOKIE_NAME, sessionCookieOptions } from "@/server/auth/cookies";
import { loadAppUrl } from "@/server/auth/config";
import {
  clientIpFromRequest,
  emailRateLimitKey,
  isSameOriginAuthRequest,
} from "@/server/auth/http-security";
import { loginLocalUser, LocalAuthError } from "@/server/auth/local-auth";
import {
  consumeRateLimits,
  LOCAL_AUTH_RATE_LIMITS,
  withRateLimitKey,
} from "@/server/auth/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<NextResponse> {
  // 模式闸门（§7.1）：certus-only 部署下本地登录必须 404 而不是隐藏入口
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
  const password = String(form.get("password") ?? "");
  const rateLimit = await consumeRateLimits([
    withRateLimitKey(LOCAL_AUTH_RATE_LIMITS.loginIp, clientIpFromRequest(request)),
    withRateLimitKey(LOCAL_AUTH_RATE_LIMITS.loginAccount, emailRateLimitKey(email)),
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
  // local 模式下不要求 CERTUS_*：会话 Cookie 只需要 secure 判定（#97）
  const cookieConfig = { secureCookies: appUrl.protocol === "https:" };

  try {
    const login = await loginLocalUser({ email, password });
    if (!login) {
      // Unreachable in practice (login throws); kept for exhaustiveness.
      return NextResponse.json(
        { ok: false, error: { code: "invalid_credentials" } },
        { status: 401 },
      );
    }
    const response = NextResponse.redirect(new URL("/", appUrl), 303);
    response.headers.set("Cache-Control", "no-store");
    response.cookies.set(
      SESSION_COOKIE_NAME,
      login.token,
      sessionCookieOptions(cookieConfig, login.sessionExpiresAt),
    );
    return response;
  } catch (cause) {
    if (cause instanceof LocalAuthError) {
      // 浏览器表单导航回登录页展示错误；API 调用保持 JSON 契约
      if (wantsHtmlRedirect(request)) {
        const target = new URL("/login", appUrl);
        target.searchParams.set("error", cause.code);
        return NextResponse.redirect(target, 303);
      }
      const status =
        cause.code === "account_locked"
          ? 423
          : cause.code === "account_suspended"
            ? 403
            : 401;
      return NextResponse.json(
        { ok: false, error: { code: cause.code, message: cause.message } },
        { status },
      );
    }
    throw cause;
  }
}
