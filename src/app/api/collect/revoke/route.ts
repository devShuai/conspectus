import { NextResponse } from "next/server";

import { db } from "@/server/db";
import { introspectCliToken } from "@/server/usage/device-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Revoke a single collector device (single-device revocation, design §7.4). */
export async function POST(request: Request): Promise<NextResponse> {
  const sub = await introspectCliToken(request.headers.get("authorization"));
  if (!sub) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const user = await db.user.findUnique({ where: { certusSub: sub } });
  if (!user) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const body = (await request.json()) as { deviceId?: string };
  if (!body.deviceId) {
    return NextResponse.json({ error: "missing_device_id" }, { status: 400 });
  }
  const updated = await db.collectorDevice.updateMany({
    where: { id: body.deviceId, userId: user.id, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  if (updated.count !== 1) {
    return NextResponse.json({ error: "device_not_found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
