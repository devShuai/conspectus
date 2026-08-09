import { NextResponse } from "next/server";

import { db } from "@/server/db";
import { clientIpFromRequest } from "@/server/auth/http-security";
import {
  COLLECT_RATE_LIMITS,
  consumeRateLimits,
  withRateLimitKey,
} from "@/server/auth/rate-limit";
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

  // §9：采集上报端点按 IP + 用户限流（计数在 PostgreSQL，多实例共享）
  const rateLimit = await consumeRateLimits([
    withRateLimitKey(COLLECT_RATE_LIMITS.usageIp, clientIpFromRequest(request)),
    withRateLimitKey(COLLECT_RATE_LIMITS.usageUser, user.id),
  ]);
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds) } },
    );
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

  // deviceId 随快照固化（§7.4 多设备与乱序：同采集时间不同设备用 Snapshot ID 决胜）
  const result = await ingestReadings(user.id, readings.data, new Date(), {
    deviceId: gate.deviceId,
  });
  await db.collectorDevice.update({
    where: { id: gate.deviceId },
    data: { lastSeenAt: new Date(), lastReportStatus: "ok" },
  });
  // 一律 202 { accepted, rejected[] }（§7.4 上报流程），零接受不是错误
  return NextResponse.json(
    { accepted: result.accepted, rejected: result.rejected },
    { status: 202 },
  );
}
