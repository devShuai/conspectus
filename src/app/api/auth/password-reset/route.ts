import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { loadAppUrl } from "@/server/auth/config";
import {
  clientIpFromRequest,
  isSameOriginAuthRequest,
  tokenRateLimitKey,
} from "@/server/auth/http-security";
import { consumePasswordResetToken } from "@/server/auth/one-time-tokens";
import { hashPassword } from "@/server/auth/password";
import {
  consumeRateLimits,
  LOCAL_AUTH_RATE_LIMITS,
  withRateLimitKey,
} from "@/server/auth/rate-limit";
import { db } from "@/server/db";

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
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch {
    return NextResponse.json(
      { ok: false, error: { code: "invalid_token" } },
      { status: 400 },
    );
  }
}
