import { NextResponse } from "next/server";

import { db } from "@/server/db";
import { introspectCliToken } from "@/server/usage/device-auth";
import { verifyDeviceSignature } from "@/server/usage/device-signature";
import { ingestReadings } from "@/server/usage/ingest";
import { UsageReadingSchema } from "@/server/usage/reading";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PATH = "/api/collect/usage";

/**
 * POST /api/collect/usage — local collector reporting.
 *
 * Three independent gates, all mandatory (design §8): certus token
 * (usage:write, client=conspectus-cli), device signature over
 * method+path+timestamp+nonce+bodyHash with one-time nonce, and a strict Zod
 * allow-list on the readings.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const sub = await introspectCliToken(request.headers.get("authorization"));
  if (!sub) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const user = await db.user.findUnique({ where: { certusSub: sub } });
  if (!user || user.status === "suspended") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const bodyText = await request.text();

  const gate = await verifyDeviceSignature({
    userId: user.id,
    headers: {
      deviceId: request.headers.get("x-device-id"),
      signature: request.headers.get("x-device-signature"),
      timestamp: request.headers.get("x-device-timestamp"),
      nonce: request.headers.get("x-device-nonce"),
    },
    method: "POST",
    path: PATH,
    bodyText,
  });
  if (!gate.ok) {
    return NextResponse.json({ error: gate.reason }, { status: 403 });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const readings = UsageReadingSchema.array().safeParse(
    (parsed as { readings?: unknown }).readings,
  );
  if (!readings.success) {
    return NextResponse.json({ error: "invalid_readings" }, { status: 400 });
  }

  const result = await ingestReadings(user.id, readings.data);
  await db.collectorDevice.update({
    where: { id: gate.deviceId },
    data: { lastSeenAt: new Date(), lastReportStatus: "ok" },
  });
  return NextResponse.json(
    { accepted: result.accepted, rejected: result.rejected },
    { status: result.accepted > 0 ? 202 : 400 },
  );
}
