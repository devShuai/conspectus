import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { SESSION_COOKIE_NAME, sessionCookieOptions } from "@/server/auth/cookies";
import { loadAuthConfig } from "@/server/auth/config";
import { loginLocalUser, LocalAuthError } from "@/server/auth/local-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Sliding-window IP limiter (process-local; DB-backed multi-instance is a M5 concern). */
const ipAttempts = new Map<string, number[]>();
const IP_WINDOW_MS = 10 * 60 * 1000;
const IP_MAX_ATTEMPTS = 20;

function ipAllowed(ip: string, now = Date.now()): boolean {
  const window = (ipAttempts.get(ip) ?? []).filter((t) => now - t < IP_WINDOW_MS);
  ipAttempts.set(ip, window);
  return window.length < IP_MAX_ATTEMPTS;
}

function recordIpAttempt(ip: string, now = Date.now()): void {
  const window = ipAttempts.get(ip) ?? [];
  window.push(now);
  ipAttempts.set(ip, window);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const config = loadAuthConfig();
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  if (!ipAllowed(ip)) {
    return NextResponse.json(
      { ok: false, error: { code: "rate_limited" } },
      { status: 429 },
    );
  }
  recordIpAttempt(ip);

  const form = await request.formData();
  const email = String(form.get("email") ?? "");
  const password = String(form.get("password") ?? "");

  try {
    const login = await loginLocalUser({ email, password });
    if (!login) {
      // Unreachable in practice (login throws); kept for exhaustiveness.
      return NextResponse.json(
        { ok: false, error: { code: "invalid_credentials" } },
        { status: 401 },
      );
    }
    const response = NextResponse.redirect(new URL("/me", config.appUrl), 303);
    response.headers.set("Cache-Control", "no-store");
    response.cookies.set(
      SESSION_COOKIE_NAME,
      login.token,
      sessionCookieOptions(config, login.sessionExpiresAt),
    );
    return response;
  } catch (cause) {
    if (cause instanceof LocalAuthError) {
      const status = cause.code === "account_locked" ? 423 : 401;
      return NextResponse.json(
        { ok: false, error: { code: cause.code, message: cause.message } },
        { status },
      );
    }
    throw cause;
  }
}
