import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { loadAppUrl } from "@/server/auth/config";
import {
  clientIpFromRequest,
  emailRateLimitKey,
  isSameOriginAuthRequest,
} from "@/server/auth/http-security";
import { registerLocalUser, LocalAuthError } from "@/server/auth/local-auth";
import {
  consumeRateLimits,
  LOCAL_AUTH_RATE_LIMITS,
  withRateLimitKey,
} from "@/server/auth/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<NextResponse> {
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

  try {
    const { userId } = await registerLocalUser({ email, password });
    // M1b: registration succeeds; email verification is a follow-up (#20).
    return NextResponse.json({ ok: true, userId }, { status: 201 });
  } catch (cause) {
    if (cause instanceof LocalAuthError) {
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
