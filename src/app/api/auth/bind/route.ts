import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { db } from "@/server/db";
import { loadAuthConfig } from "@/server/auth/config";
import { dbSessionWriter } from "@/server/auth/db-flow";
import {
  bindCertusToUser,
  BindError,
  certusSubFromClaimsForBind,
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

/** Bind certus sub to current user (local user performs certus OIDC once). */
export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!originOk(request)) {
    return NextResponse.json({ ok: false, error: "invalid_origin" }, { status: 403 });
  }
  const session = await requireSession(request);
  if (!session) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const form = await request.formData();
  const sub = String(form.get("sub") ?? "");
  if (!sub) {
    return NextResponse.json({ ok: false, error: "missing_sub" }, { status: 400 });
  }
  try {
    await bindCertusToUser({
      userId: session.userId,
      claims: { sub },
      config: loadAuthConfig(),
    });
    return NextResponse.json({ ok: true });
  } catch (cause) {
    if (cause instanceof BindError) {
      const status =
        cause.code === "last_auth_method" ? 409 : cause.code === "sub_in_use" ? 409 : 400;
      return NextResponse.json(
        { ok: false, error: { code: cause.code } },
        { status },
      );
    }
    throw cause;
  }
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

void db;
void certusSubFromClaimsForBind;
