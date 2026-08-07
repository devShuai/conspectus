import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import {
  expiredSessionCookieOptions,
  SESSION_COOKIE_NAME,
} from "@/server/auth/cookies";
import { loadAuthConfig } from "@/server/auth/config";
import { dbSessionWriter } from "@/server/auth/db-flow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const config = loadAuthConfig();
  const origin = request.headers.get("origin");
  if (origin && origin !== config.appUrl.origin) {
    return NextResponse.json({ error: "invalid_origin" }, { status: 403 });
  }

  await dbSessionWriter.delete(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  const response = NextResponse.redirect(config.appUrl, 303);
  response.headers.set("Cache-Control", "no-store");
  response.cookies.set(
    SESSION_COOKIE_NAME,
    "",
    expiredSessionCookieOptions(config),
  );
  return response;
}
