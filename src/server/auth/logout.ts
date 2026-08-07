import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { db } from "@/server/db";
import {
  expiredSessionCookieOptions,
  SESSION_COOKIE_NAME,
} from "@/server/auth/cookies";
import { loadAuthConfig, type AuthConfig } from "@/server/auth/config";
import { dbSessionWriter } from "@/server/auth/db-flow";
import {
  decryptSessionTokenCipher,
  toStoredBytes,
  tokenHashOf,
} from "@/server/auth/session-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function originOk(request: NextRequest, config: { appUrl: URL }): boolean {
  const origin = request.headers.get("origin");
  return !origin || origin === config.appUrl.origin;
}

/**
 * Local logout: destroy this site's session. POST + origin check only —
 * a plain GET or cross-site form must never log out.
 */
export async function localLogout(request: NextRequest): Promise<NextResponse> {
  const config = loadAuthConfig();
  if (!originOk(request, config)) {
    return NextResponse.json({ error: "invalid_origin" }, { status: 403 });
  }
  await dbSessionWriter.delete(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  return logoutRedirect(config, config.appUrl);
}

/**
 * Global logout (POST only): destroy local session, then 303 to certus
 * end_session with id_token_hint for RP-Initiated Logout.
 */
export async function certusGlobalLogout(
  request: NextRequest,
): Promise<NextResponse> {
  const config = loadAuthConfig();
  if (!originOk(request, config)) {
    return NextResponse.json({ error: "invalid_origin" }, { status: 403 });
  }

  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  let idTokenHint: string | undefined;
  if (token) {
    const row = await db.session.findUnique({
      where: { tokenHash: toStoredBytes(tokenHashOf(token)) },
      select: { certusIdTokenCipher: true, authMethod: true },
    });
    if (row?.certusIdTokenCipher) {
      idTokenHint = decryptSessionTokenCipher(row.certusIdTokenCipher) ?? undefined;
    }
    await dbSessionWriter.delete(token);
  }

  if (idTokenHint) {
    const endSession = new URL("/oauth2/logout", config.issuer);
    endSession.searchParams.set("id_token_hint", idTokenHint);
    endSession.searchParams.set(
      "post_logout_redirect_uri",
      new URL("/logout/done", config.appUrl).href,
    );
    return logoutRedirect(config, endSession);
  }
  return logoutRedirect(config, config.appUrl);
}

function logoutRedirect(config: AuthConfig, target: URL): NextResponse {
  const response = NextResponse.redirect(target, 303);
  response.headers.set("Cache-Control", "no-store");
  response.cookies.set(
    SESSION_COOKIE_NAME,
    "",
    expiredSessionCookieOptions(config),
  );
  return response;
}
