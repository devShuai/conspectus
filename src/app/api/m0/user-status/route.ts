import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { getCertusSubForSession } from "@/server/auth/claim-evidence";
import { fetchUserStatus } from "@/server/auth/certus-client-api";
import { SESSION_COOKIE_NAME } from "@/server/auth/cookies";
import { loadAuthConfig } from "@/server/auth/config";
import { findAppSession } from "@/server/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * M0-only: probe certus user status for the Session's certus sub.
 * Response never includes raw sub or email.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const session = findAppSession(token);
  if (!session) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const certusSub = getCertusSubForSession(token ?? "");
  if (!certusSub) {
    return NextResponse.json(
      {
        ok: false,
        error: "no_claim_evidence",
        hint: "Log in again in this process so claim evidence is captured.",
      },
      { status: 409 },
    );
  }
  const config = loadAuthConfig();
  const status = await fetchUserStatus(config, certusSub);
  return NextResponse.json(
    {
      ok: true,
      localUserId: session.userId,
      status: {
        httpStatus: status.httpStatus,
        userStatus: status.status,
        emailVerified: status.emailVerified,
        hasUpdatedAt: status.hasUpdatedAt,
        subjectFingerprint: status.subjectFingerprint,
        leakedProfileFields: status.leakedProfileFields,
        notFoundOpaque: status.notFoundOpaque,
      },
    },
    { headers: { "cache-control": "no-store" } },
  );
}
