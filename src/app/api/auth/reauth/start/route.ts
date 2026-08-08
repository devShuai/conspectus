import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import {
  OIDC_TRANSACTION_COOKIE_NAME,
  REAUTH_COOKIE_NAME,
  reauthCookieOptions,
  transactionCookieOptions,
} from "@/server/auth/cookies";
import { loadAuthConfig } from "@/server/auth/config";
import { currentAppSession } from "@/server/auth/current-session";
import {
  REAUTH_ACTIONS,
  startReauthFlow,
  type ReauthAction,
} from "@/server/auth/reauth-flow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 只允许站内相对路径，防开放重定向。 */
function sanitizeTarget(raw: string | null): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) {
    return "/settings/data";
  }
  return raw;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const config = loadAuthConfig();
  const session = await currentAppSession();
  if (!session) {
    return NextResponse.redirect(new URL("/login", config.appUrl), 302);
  }

  const rawAction = request.nextUrl.searchParams.get("action") ?? "";
  if (!(REAUTH_ACTIONS as readonly string[]).includes(rawAction)) {
    return NextResponse.json({ error: "unknown_action" }, { status: 400 });
  }
  const target = sanitizeTarget(request.nextUrl.searchParams.get("target"));

  const flow = await startReauthFlow({
    userId: session.userId,
    action: rawAction as ReauthAction,
    targetPath: target,
  });

  const response = NextResponse.redirect(flow.authorizationUrl, 302);
  response.headers.set("Cache-Control", "no-store");
  response.cookies.set(
    OIDC_TRANSACTION_COOKIE_NAME,
    flow.oidcHandle,
    transactionCookieOptions(config, flow.oidcExpiresAt),
  );
  response.cookies.set(
    REAUTH_COOKIE_NAME,
    flow.reauthContext,
    reauthCookieOptions(config, flow.reauthExpiresAt),
  );
  return response;
}
