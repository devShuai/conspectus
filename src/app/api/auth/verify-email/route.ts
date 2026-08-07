import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { consumeEmailVerificationToken } from "@/server/auth/one-time-tokens";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const token = request.nextUrl.searchParams.get("token");
  if (!token) {
    return NextResponse.json({ ok: false, error: "missing_token" }, { status: 400 });
  }
  try {
    await consumeEmailVerificationToken(token);
    const target = new URL("/me?verified=1", process.env.APP_URL ?? "http://127.0.0.1:3000");
    return NextResponse.redirect(target, 303);
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_token" }, { status: 400 });
  }
}
