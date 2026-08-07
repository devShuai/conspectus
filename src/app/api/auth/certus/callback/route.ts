import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import {
  expiredTransactionCookieOptions,
  OIDC_TRANSACTION_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  sessionCookieOptions,
} from "@/server/auth/cookies";
import { loadAuthConfig } from "@/server/auth/config";
import { dbSessionWriter } from "@/server/auth/db-flow";
import {
  canonicalOIDCCallbackURL,
  completeOIDCLogin,
  OIDCFlowError,
} from "@/server/auth/flow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const config = loadAuthConfig();
  const transactionHandle = request.cookies.get(OIDC_TRANSACTION_COOKIE_NAME)?.value;

  try {
    const login = await completeOIDCLogin(
      canonicalOIDCCallbackURL(config, request.nextUrl.searchParams),
      transactionHandle,
      { config, sessions: dbSessionWriter },
    );
    const response = NextResponse.redirect(new URL("/me", config.appUrl), 303);
    response.headers.set("Cache-Control", "no-store");
    response.cookies.set(
      SESSION_COOKIE_NAME,
      login.sessionToken,
      sessionCookieOptions(config, login.sessionExpiresAt),
    );
    response.cookies.set(
      OIDC_TRANSACTION_COOKIE_NAME,
      "",
      expiredTransactionCookieOptions(config),
    );
    return response;
  } catch (error) {
    const code = error instanceof OIDCFlowError ? error.code : "unexpected_error";
    if (process.env.NODE_ENV !== "production") {
      const cause = error instanceof Error ? error.cause : undefined;
      const detail =
        cause instanceof Error
          ? cause.name
          : error instanceof Error
            ? error.name
            : typeof error;
      console.error("[auth/callback]", code, detail);
    }
    const target = new URL("/auth/error", config.appUrl);
    target.searchParams.set("code", code);
    const response = NextResponse.redirect(target, 303);
    response.headers.set("Cache-Control", "no-store");
    response.cookies.set(
      OIDC_TRANSACTION_COOKIE_NAME,
      "",
      expiredTransactionCookieOptions(config),
    );
    return response;
  }
}
