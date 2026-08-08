import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { authModeGate } from "@/server/auth/auth-mode";
import {
  OIDC_TRANSACTION_COOKIE_NAME,
  RETURN_COOKIE_NAME,
  returnCookieOptions,
  transactionCookieOptions,
} from "@/server/auth/cookies";
import { loadAuthConfig } from "@/server/auth/config";
import { startOIDCLogin } from "@/server/auth/flow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 只允许站内相对路径，防开放重定向。 */
function sanitizeReturn(raw: string | null): string | null {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return null;
  return raw;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  // 模式闸门（§7.1）：local-only 部署下 certus 端点必须 404
  const gate = authModeGate("certus");
  if (gate) return gate;
  const config = loadAuthConfig();
  const login = await startOIDCLogin({ config });
  const response = NextResponse.redirect(login.authorizationUrl, 302);
  response.headers.set("Cache-Control", "no-store");
  response.cookies.set(
    OIDC_TRANSACTION_COOKIE_NAME,
    login.transactionHandle,
    transactionCookieOptions(config, login.expiresAt),
  );
  const returnTo = sanitizeReturn(request.nextUrl.searchParams.get("return"));
  if (returnTo) {
    response.cookies.set(
      RETURN_COOKIE_NAME,
      returnTo,
      returnCookieOptions(config, login.expiresAt),
    );
  }
  return response;
}
