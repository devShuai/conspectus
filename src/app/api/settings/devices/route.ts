import { NextResponse } from "next/server";

import { db } from "@/server/db";
import { SESSION_COOKIE_NAME } from "@/server/auth/cookies";
import { dbSessionWriter } from "@/server/auth/db-flow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Settings API: revoke a collector device (session-authenticated). */
export async function POST(request: Request): Promise<NextResponse> {
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
  const body = (await request.json()) as { deviceId?: string };
  if (!body.deviceId) {
    return NextResponse.json({ error: "missing_device_id" }, { status: 400 });
  }
  const updated = await db.collectorDevice.updateMany({
    where: { id: body.deviceId, userId: session.userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  if (updated.count !== 1) {
    return NextResponse.json({ error: "device_not_found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
