import { NextResponse } from "next/server";

import {
  OIDC_TRANSACTION_COOKIE_NAME,
  transactionCookieOptions,
} from "@/server/auth/cookies";
import { loadAuthConfig } from "@/server/auth/config";
import { startOIDCLogin } from "@/server/auth/flow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const config = loadAuthConfig();
  const login = await startOIDCLogin({ config });
  const response = NextResponse.redirect(login.authorizationUrl, 302);
  response.headers.set("Cache-Control", "no-store");
  response.cookies.set(
    OIDC_TRANSACTION_COOKIE_NAME,
    login.transactionHandle,
    transactionCookieOptions(config, login.expiresAt),
  );
  return response;
}
