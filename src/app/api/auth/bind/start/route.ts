import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import {
  OIDC_TRANSACTION_COOKIE_NAME,
  RETURN_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  returnCookieOptions,
  transactionCookieOptions,
} from "@/server/auth/cookies";
import { loadAuthConfig } from "@/server/auth/config";
import { dbSessionWriter } from "@/server/auth/db-flow";
import { startBindFlow } from "@/server/auth/bind-flow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Only same-site relative paths, to keep this off the open-redirect surface. */
function sanitizeReturn(raw: string | null): string | null {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return null;
  return raw;
}

/**
 * Start "bind certus to this account" (design §7.1). Requires an existing
 * session: the merge may only be initiated by the signed-in user, and the
 * subject is taken from the resulting ID Token rather than from client input
 * (#96).
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const config = loadAuthConfig();
  const session = await dbSessionWriter.find(
    request.cookies.get(SESSION_COOKIE_NAME)?.value,
  );
  if (!session) {
    const target = new URL("/login", config.appUrl);
    const response = NextResponse.redirect(target, 303);
    response.headers.set("Cache-Control", "no-store");
    return response;
  }

  const bind = await startBindFlow({ userId: session.userId, config });
  const response = NextResponse.redirect(bind.authorizationUrl, 302);
  response.headers.set("Cache-Control", "no-store");
  response.cookies.set(
    OIDC_TRANSACTION_COOKIE_NAME,
    bind.oidcHandle,
    transactionCookieOptions(config, bind.oidcExpiresAt),
  );
  const returnTo = sanitizeReturn(request.nextUrl.searchParams.get("return"));
  if (returnTo) {
    response.cookies.set(
      RETURN_COOKIE_NAME,
      returnTo,
      returnCookieOptions(config, bind.oidcExpiresAt),
    );
  }
  return response;
}
