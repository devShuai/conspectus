import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { db } from "@/server/db";
import { authModeGate } from "@/server/auth/auth-mode";
import { loadAuthConfig } from "@/server/auth/config";
import {
  deleteCertusSessionsBySub,
  deleteSessionsBySid,
} from "@/server/auth/session-db";
import {
  LogoutTokenError,
  logoutReplayExpiry,
  validateLogoutToken,
} from "@/server/auth/logout-token";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * certus Back-Channel Logout (OIDC).
 * - validate signature/claims (issuer, aud, typ=logout+jwt, jti, sid|sub, events)
 * - insert BackchannelLogoutReplay in the SAME transaction as session deletion;
 *   unique (issuer, jti) makes replays idempotent 200 without side effects.
 * - sid preferred; sub fallback deletes ONLY authMethod=certus sessions.
 * - Never writes User.suspended (logout is not account disablement).
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const gate = authModeGate("certus");
  if (gate) return gate;
  const config = loadAuthConfig();
  const form = await request.formData();
  const rawToken = form.get("logout_token");

  if (typeof rawToken !== "string" || rawToken.length === 0) {
    return NextResponse.json({ error: "missing logout_token" }, { status: 400 });
  }

  let claims;
  try {
    claims = await validateLogoutToken(rawToken, config);
  } catch (cause) {
    if (process.env.NODE_ENV !== "production") {
      const reason =
        cause instanceof LogoutTokenError ? cause.reason : "unexpected_error";
      console.error("[auth/backchannel-logout] rejected", reason);
    }
    // Always 400 for invalid tokens; body carries no token material.
    return NextResponse.json(
      { error: "invalid logout_token" },
      { status: 400 },
    );
  }

  const now = new Date();
  try {
    await db.$transaction(async (tx) => {
      const replay = await tx.backchannelLogoutReplay.create({
        data: {
          issuer: claims.iss,
          jti: claims.jti,
          expiresAt: logoutReplayExpiry(claims.exp, now),
        },
      });
      // If insert won, perform revocation in the same transaction.
      if (claims.sid) {
        await tx.session.deleteMany({
          where: { certusSid: claims.sid, authMethod: "certus" },
        });
      } else if (claims.sub) {
        const users = await tx.user.findMany({
          where: { certusSub: claims.sub },
          select: { id: true },
        });
        await tx.session.deleteMany({
          where: {
            userId: { in: users.map((u) => u.id) },
            authMethod: "certus",
          },
        });
      }
      return replay;
    });
  } catch (cause) {
    // P2002 unique violation = already processed → idempotent success.
    const prismaError = cause as { code?: string };
    if (prismaError.code === "P2002") {
      return new NextResponse(null, { status: 200 });
    }
    if (process.env.NODE_ENV !== "production") {
      console.error("[auth/backchannel-logout] storage error", prismaError.code);
    }
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }

  return new NextResponse(null, { status: 200 });
}
