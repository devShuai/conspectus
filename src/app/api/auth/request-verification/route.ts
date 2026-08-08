import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { authModeGate } from "@/server/auth/auth-mode";
import { normalizeEmail } from "@/server/auth/email";
import { sendEmail } from "@/server/auth/email-sender";
import { issueEmailVerificationToken } from "@/server/auth/one-time-tokens";
import { db } from "@/server/db";

/** Request email verification link (local accounts only). */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const gate = authModeGate("local");
  if (gate) return gate;
  const form = await request.formData();
  const email = String(form.get("email") ?? "");
  let normalized: string;
  try {
    normalized = normalizeEmail(email);
  } catch {
    return NextResponse.json({ ok: true }, { status: 200 });
  }
  const user = await db.user.findFirst({
    where: { email: normalized, passwordHash: { not: null } },
  });
  if (user) {
    const token = await issueEmailVerificationToken(user.id, normalized);
    const appUrl = process.env.APP_URL ?? "http://127.0.0.1:3000";
    await sendEmail({
      to: normalized,
      subject: "验证邮箱",
      text: `请打开以下链接验证邮箱（30 分钟内有效）：\n${appUrl}/api/auth/verify-email?token=${token}`,
    });
  }
  return NextResponse.json({ ok: true }, { status: 200 });
}
