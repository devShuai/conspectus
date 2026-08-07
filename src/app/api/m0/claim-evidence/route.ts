import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { getPublicClaimEvidenceForSession } from "@/server/auth/claim-evidence";
import { SESSION_COOKIE_NAME } from "@/server/auth/cookies";
import { loadAuthConfig } from "@/server/auth/config";
import { findAppSession } from "@/server/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** M0-only: redacted ID Token claim presence for the current Session. */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const session = findAppSession(token);
  if (!session) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const evidence = getPublicClaimEvidenceForSession(token ?? "");
  const config = loadAuthConfig();
  return NextResponse.json(
    {
      ok: true,
      userId: session.userId,
      issuer: config.issuerIdentifier,
      idToken: evidence,
    },
    {
      headers: { "cache-control": "no-store" },
    },
  );
}
