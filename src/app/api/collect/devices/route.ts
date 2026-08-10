import { NextResponse } from "next/server";

import { db } from "@/server/db";
import { clientIpFromRequest } from "@/server/auth/http-security";
import {
  COLLECT_RATE_LIMITS,
  consumeRateLimits,
  withRateLimitKey,
} from "@/server/auth/rate-limit";
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

  // §9：采集上报端点按 IP + 用户限流（计数在 PostgreSQL，多实例共享）
  const rateLimit = await consumeRateLimits([
    withRateLimitKey(COLLECT_RATE_LIMITS.devicesIp, clientIpFromRequest(request)),
    withRateLimitKey(COLLECT_RATE_LIMITS.devicesUser, user.id),
  ]);
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds) } },
    );
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
      // 只记采集器自报的版本。此前缺省填 "0.1.0"，那一列于是永远显示一个从未被
      // 证实过的数字 —— 用户拿它判断「采集器是不是太旧」时会被直接误导。没报就留空。
      agentVersion: typeof body.agentVersion === "string" ? body.agentVersion : null,
      publicKey,
      keyAlgorithm: body.keyAlgorithm ?? "Ed25519",
    },
  });
  return NextResponse.json({ ok: true, deviceId: device.id }, { status: 201 });
}
