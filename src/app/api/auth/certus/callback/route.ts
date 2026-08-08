import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import {
  expiredReauthCookieOptions,
  expiredReturnCookieOptions,
  expiredTransactionCookieOptions,
  OIDC_TRANSACTION_COOKIE_NAME,
  REAUTH_COOKIE_NAME,
  RETURN_COOKIE_NAME,
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
import {
  completeReauthFlow,
  ReauthFlowError,
} from "@/server/auth/reauth-flow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const config = loadAuthConfig();
  const transactionHandle = request.cookies.get(OIDC_TRANSACTION_COOKIE_NAME)?.value;
  const reauthContext = request.cookies.get(REAUTH_COOKIE_NAME)?.value;

  // reauth 分支：不建会话，只校验 auth_time/sub 并标记事务已验证（design §7.1）
  if (reauthContext) {
    try {
      const done = await completeReauthFlow({
        currentUrl: canonicalOIDCCallbackURL(config, request.nextUrl.searchParams),
        oidcHandle: transactionHandle,
        reauthContext,
      });
      const target = new URL(done.targetPath, config.appUrl);
      target.searchParams.set("reauth", done.token);
      const response = NextResponse.redirect(target, 303);
      response.headers.set("Cache-Control", "no-store");
      response.cookies.set(
        OIDC_TRANSACTION_COOKIE_NAME,
        "",
        expiredTransactionCookieOptions(config),
      );
      response.cookies.set(REAUTH_COOKIE_NAME, "", expiredReauthCookieOptions(config));
      return response;
    } catch (error) {
      const code = error instanceof ReauthFlowError ? error.code : "unexpected_error";
      const target = new URL("/auth/error", config.appUrl);
      target.searchParams.set("code", `reauth_${code}`);
      const response = NextResponse.redirect(target, 303);
      response.headers.set("Cache-Control", "no-store");
      response.cookies.set(
        OIDC_TRANSACTION_COOKIE_NAME,
        "",
        expiredTransactionCookieOptions(config),
      );
      response.cookies.set(REAUTH_COOKIE_NAME, "", expiredReauthCookieOptions(config));
      return response;
    }
  }

  try {
    const login = await completeOIDCLogin(
      canonicalOIDCCallbackURL(config, request.nextUrl.searchParams),
      transactionHandle,
      { config, sessions: dbSessionWriter },
    );
    // 回到原始目标页（§7.1），默认总览；Cookie 值在 start 时已过滤为站内路径
    const returnTo = request.cookies.get(RETURN_COOKIE_NAME)?.value;
    const target =
      returnTo && returnTo.startsWith("/") && !returnTo.startsWith("//") ? returnTo : "/";
    const response = NextResponse.redirect(new URL(target, config.appUrl), 303);
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
    response.cookies.set(RETURN_COOKIE_NAME, "", expiredReturnCookieOptions(config));
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
