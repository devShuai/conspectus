import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { loadAuthConfig } from "@/server/auth/config";
import { dbSessionWriter } from "@/server/auth/db-flow";
import {
  BindError,
  unbindCertusFromUser,
  unbindLocalPasswordFromUser,
} from "@/server/auth/bind";
import { SESSION_COOKIE_NAME } from "@/server/auth/cookies";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function originOk(request: NextRequest): boolean {
  const config = loadAuthConfig();
  const origin = request.headers.get("origin");
  return !origin || origin === config.appUrl.origin;
}

async function requireSession(request: NextRequest): Promise<{ userId: string } | null> {
  return dbSessionWriter.find(request.cookies.get(SESSION_COOKIE_NAME)?.value);
}

/**
 * Binding certus is NOT a POST with a `sub`.
 *
 * The previous implementation wrote whatever subject the form carried straight
 * into User.certusSub. `sub_in_use` only rejected subjects already taken, so a
 * signed-in user could claim any certus account that had not logged in yet;
 * when the real owner arrived, JIT attached them to the squatter's row (#96).
 *
 * Binding now runs a real certus authorization: GET /api/auth/bind/start, and
 * the shared callback writes the `sub` from the resulting ID Token.
 */
export async function POST(): Promise<NextResponse> {
  return NextResponse.json(
    {
      ok: false,
      error: { code: "use_oidc_bind", start: "/api/auth/bind/start" },
    },
    { status: 405, headers: { allow: "DELETE, PATCH" } },
  );
}

/** Unbind certus (keep local password). */
export async function DELETE(request: NextRequest): Promise<NextResponse> {
  if (!originOk(request)) {
    return NextResponse.json({ ok: false, error: "invalid_origin" }, { status: 403 });
  }
  const session = await requireSession(request);
  if (!session) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  try {
    await unbindCertusFromUser(session.userId);
    return NextResponse.json({ ok: true });
  } catch (cause) {
    if (cause instanceof BindError) {
      return NextResponse.json(
        { ok: false, error: { code: cause.code } },
        { status: cause.code === "last_auth_method" ? 409 : 400 },
      );
    }
    throw cause;
  }
}

/** Unbind local password (keep certus). */
export async function PATCH(request: NextRequest): Promise<NextResponse> {
  if (!originOk(request)) {
    return NextResponse.json({ ok: false, error: "invalid_origin" }, { status: 403 });
  }
  const session = await requireSession(request);
  if (!session) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const form = await request.formData();
  const action = String(form.get("action") ?? "");
  try {
    if (action === "unbind-local") {
      await unbindLocalPasswordFromUser(session.userId);
      return NextResponse.json({ ok: true });
    }
    if (action === "set-password") {
      const { setLocalPassword } = await import("@/server/auth/bind");
      const password = String(form.get("password") ?? "");
      await setLocalPassword(session.userId, password);
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ ok: false, error: "unknown_action" }, { status: 400 });
  } catch (cause) {
    if (cause instanceof BindError) {
      return NextResponse.json(
        { ok: false, error: { code: cause.code } },
        { status: cause.code === "last_auth_method" ? 409 : 400 },
      );
    }
    throw cause;
  }
}
