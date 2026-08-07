import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { consumePasswordResetToken } from "@/server/auth/one-time-tokens";
import { hashPassword } from "@/server/auth/password";
import { db } from "@/server/db";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const form = await request.formData();
  const token = String(form.get("token") ?? "");
  const password = String(form.get("password") ?? "");
  if (!token || password.length < 12) {
    return NextResponse.json(
      { ok: false, error: { code: "invalid_input" } },
      { status: 400 },
    );
  }
  try {
    const { userId } = await consumePasswordResetToken(token);
    const passwordHash = await hashPassword(password);
    await db.user.update({ where: { id: userId }, data: { passwordHash } });
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch {
    return NextResponse.json(
      { ok: false, error: { code: "invalid_token" } },
      { status: 400 },
    );
  }
}
