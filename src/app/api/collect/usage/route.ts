import { createPublicKey, verify } from "node:crypto";

import { NextResponse } from "next/server";

import { db } from "@/server/db";
import { introspectCliToken } from "@/server/usage/device-auth";
import { ingestReadings } from "@/server/usage/ingest";
import { UsageReadingSchema } from "@/server/usage/reading";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NONCE_WINDOW_MS = 5 * 60 * 1000;

/**
 * POST /api/collect/usage — local collector reporting.
 * Requires certus token (usage:write, client=conspectus-cli), device signature
 * (method+path+timestamp+nonce+bodyHash), and strict Zod allow-list.
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

  const deviceId = request.headers.get("x-device-id");
  const signature = request.headers.get("x-device-signature");
  const timestamp = request.headers.get("x-device-timestamp");

  const bodyText = await request.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  // Device signature gate (Ed25519 over method+path+timestamp+nonce+bodyHash)
  if (deviceId && signature && timestamp) {
    const device = await db.collectorDevice.findFirst({
      where: { id: deviceId, userId: user.id, revokedAt: null },
    });
    if (!device) {
      return NextResponse.json({ error: "device_not_found" }, { status: 403 });
    }
    const ts = new Date(timestamp).getTime();
    if (Number.isNaN(ts) || Math.abs(Date.now() - ts) > NONCE_WINDOW_MS) {
      return NextResponse.json({ error: "timestamp_out_of_window" }, { status: 403 });
    }
    const { createHash } = await import("node:crypto");
    const bodyHash = createHash("sha256").update(bodyText).digest("hex");
    const signedMessage = `POST /api/collect/usage\n${timestamp}\n${bodyHash}`;
    let ok = false;
    try {
      const pub = createPublicKey({
        key: Buffer.from(device.publicKey),
        format: "der",
        type: "spki",
      });
      ok = verify(
        null,
        Buffer.from(signedMessage, "utf8"),
        pub,
        Buffer.from(signature, "base64"),
      );
    } catch {
      ok = false;
    }
    if (!ok) {
      return NextResponse.json({ error: "invalid_signature" }, { status: 403 });
    }
    await db.collectorDevice.update({
      where: { id: device.id },
      data: { lastSeenAt: new Date(), lastReportStatus: "ok" },
    });
  }

  const readings = UsageReadingSchema.array().safeParse(
    (parsed as { readings?: unknown }).readings,
  );
  if (!readings.success) {
    return NextResponse.json({ error: "invalid_readings" }, { status: 400 });
  }

  const result = await ingestReadings(user.id, readings.data);
  return NextResponse.json(
    { accepted: result.accepted, rejected: result.rejected },
    { status: result.accepted > 0 ? 202 : 400 },
  );
}
