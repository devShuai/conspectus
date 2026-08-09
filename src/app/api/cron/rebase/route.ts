import { NextResponse } from "next/server";

import { processRebaseJobs } from "@/server/billing/rebase-worker";

import { cronJson } from "../json";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Currency rebase worker endpoint: auth + shard parsing only;
 * 消费逻辑（backfill → 用户级锁下复核并切换）在 server/billing/rebase-worker.ts。
 */
export async function GET(request: Request): Promise<NextResponse> {
  const authorization = request.headers.get("authorization");
  const secret = process.env.CRON_SECRET;
  if (!secret || authorization !== `Bearer ${secret}`) {
    return cronJson({ error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const shard = Number(url.searchParams.get("shard") ?? 0);
  const of = Number(url.searchParams.get("of") ?? 1);
  if (of < 1 || shard < 0 || shard >= of) {
    return cronJson({ error: "invalid_shard" }, { status: 400 });
  }

  const results = await processRebaseJobs(shard, of);
  return cronJson({ ok: true, results });
}
