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
import {
  ingestLedger,
  LedgerDaySchema,
  LedgerModelQualitySchema,
  LedgerSessionSchema,
  LedgerToolSchema,
  LEDGER_MODELS_LIMIT,
  LEDGER_ROWS_LIMIT,
  LEDGER_SESSIONS_LIMIT,
  LEDGER_TOOLS_LIMIT,
} from "@/server/usage/ledger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PATH = "/api/collect/ledger";

/**
 * POST /api/collect/ledger —— 消耗流水账上报（#143）。
 *
 * 三道闸门与 /api/collect/usage 完全一致（§8）：certus token（usage:write、
 * client=conspectus-cli）、设备签名（method+path+timestamp+nonce+bodyHash，nonce
 * 一次性）、以及严格的 Zod 白名单。
 *
 * 独立于 /api/collect/usage 而非复用：读数与流水账是两种计量，共用契约会把它们搅
 * 在一起（§4）。签名覆盖 path，所以两个端点的签名不可互换重放。
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

  const payload = parsed as {
    days?: unknown;
    sessions?: unknown;
    tools?: unknown;
    models?: unknown;
  };

  // 四张表各自限长。上限先于解析检查：先把上万行跑完 Zod 再拒绝，等于自带 DoS。
  for (const [value, limit] of [
    [payload.days, LEDGER_ROWS_LIMIT],
    [payload.sessions, LEDGER_SESSIONS_LIMIT],
    [payload.tools, LEDGER_TOOLS_LIMIT],
    [payload.models, LEDGER_MODELS_LIMIT],
  ] as const) {
    if (Array.isArray(value) && value.length > limit) {
      return NextResponse.json({ error: "too_many_rows" }, { status: 413 });
    }
  }

  const days = LedgerDaySchema.array().safeParse(payload.days);
  if (!days.success) {
    return NextResponse.json({ error: "invalid_days" }, { status: 400 });
  }
  // 后三张表缺省即空数组：0.4.x 的采集器只发 days，升级前照旧能上报
  const sessions = LedgerSessionSchema.array().safeParse(payload.sessions ?? []);
  if (!sessions.success) {
    return NextResponse.json({ error: "invalid_sessions" }, { status: 400 });
  }
  const tools = LedgerToolSchema.array().safeParse(payload.tools ?? []);
  if (!tools.success) {
    return NextResponse.json({ error: "invalid_tools" }, { status: 400 });
  }
  const models = LedgerModelQualitySchema.array().safeParse(payload.models ?? []);
  if (!models.success) {
    return NextResponse.json({ error: "invalid_models" }, { status: 400 });
  }

  const result = await ingestLedger(user.id, {
    days: days.data,
    sessions: sessions.data,
    tools: tools.data,
    models: models.data,
  });
  await db.collectorDevice.update({
    where: { id: gate.deviceId },
    data: { lastSeenAt: new Date(), lastReportStatus: "ok" },
  });
  return NextResponse.json(result, { status: 202 });
}
