import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { SESSION_COOKIE_NAME, sessionCookieOptions } from "@/server/auth/cookies";
import { loadAppUrl, loadAuthConfig } from "@/server/auth/config";
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
  const config = loadAuthConfig();

  try {
    const login = await loginLocalUser({ email, password });
    if (!login) {
      // Unreachable in practice (login throws); kept for exhaustiveness.
      return NextResponse.json(
        { ok: false, error: { code: "invalid_credentials" } },
        { status: 401 },
      );
    }
    const response = NextResponse.redirect(new URL("/", config.appUrl), 303);
    response.headers.set("Cache-Control", "no-store");
    response.cookies.set(
      SESSION_COOKIE_NAME,
      login.token,
      sessionCookieOptions(config, login.sessionExpiresAt),
    );
    return response;
  } catch (cause) {
    if (cause instanceof LocalAuthError) {
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
