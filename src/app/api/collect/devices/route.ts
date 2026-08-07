import { NextResponse } from "next/server";

import { db } from "@/server/db";
import { introspectCliToken } from "@/server/usage/device-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Register a collector device public key (certus token + introspection). */
export async function POST(request: Request): Promise<NextResponse> {
  const authorization = request.headers.get("authorization");
  const sub = await introspectCliToken(authorization);
  if (!sub) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const user = await db.user.findUnique({ where: { certusSub: sub } });
  if (!user) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const body = (await request.json()) as {
    name?: string;
    platform?: string;
    agentVersion?: string;
    publicKey?: string;
    keyAlgorithm?: string;
  };
  if (!body.publicKey) {
    return NextResponse.json({ error: "missing_public_key" }, { status: 400 });
  }
  let publicKey: Uint8Array<ArrayBuffer>;
  try {
    const buf = Buffer.from(body.publicKey, "base64");
    publicKey = new Uint8Array(
      buf.buffer as ArrayBuffer,
      buf.byteOffset,
      buf.byteLength,
    ) as Uint8Array<ArrayBuffer>;
  } catch {
    return NextResponse.json({ error: "invalid_public_key" }, { status: 400 });
  }

  const device = await db.collectorDevice.create({
    data: {
      userId: user.id,
      name: body.name ?? "未命名设备",
      platform: body.platform ?? "unknown",
      agentVersion: body.agentVersion ?? "0.1.0",
      publicKey,
      keyAlgorithm: body.keyAlgorithm ?? "Ed25519",
    },
  });
  return NextResponse.json({ ok: true, deviceId: device.id }, { status: 201 });
}
