import { NextResponse } from "next/server";

import { dashboardStats } from "@/server/billing/stats";
import { SESSION_COOKIE_NAME } from "@/server/auth/cookies";
import { dbSessionWriter } from "@/server/auth/db-flow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  const cookie = request.headers.get("cookie") ?? "";
  const token = cookie
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`))
    ?.slice(SESSION_COOKIE_NAME.length + 1);
  const session = await dbSessionWriter.find(token);
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const stats = await dashboardStats(session.userId);
  return NextResponse.json(
    { ok: true, stats },
    { headers: { "cache-control": "private, no-store" } },
  );
}
