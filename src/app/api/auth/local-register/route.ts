import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { registerLocalUser, LocalAuthError } from "@/server/auth/local-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const form = await request.formData();
  const email = String(form.get("email") ?? "");
  const password = String(form.get("password") ?? "");

  try {
    const { userId } = await registerLocalUser({ email, password });
    // M1b: registration succeeds; email verification is a follow-up (#20).
    return NextResponse.json({ ok: true, userId }, { status: 201 });
  } catch (cause) {
    if (cause instanceof LocalAuthError) {
      const status =
        cause.code === "registration_disabled"
          ? 404
          : cause.code === "email_taken"
            ? 409
            : 400;
      return NextResponse.json(
        { ok: false, error: { code: cause.code, message: cause.message } },
        { status },
      );
    }
    throw cause;
  }
}
