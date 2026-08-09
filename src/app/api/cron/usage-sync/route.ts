import { NextResponse } from "next/server";

import { resetDueQuotaCycles } from "@/server/usage/cycle-reset";
import { syncDueConnections } from "@/server/usage/sync";

import { cronJson } from "../json";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** FNV-1a 32bit：按 userId 哈希取模分片（§7.4 `?shard=k&of=n`，Serverless 时长上限时多次调度）。 */
function shardIndex(userId: string, of: number): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < userId.length; i++) {
    hash ^= userId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % of;
}

export async function GET(request: Request): Promise<NextResponse> {
  const authorization = request.headers.get("authorization");
  const secret = process.env.CRON_SECRET;
  if (!secret || authorization !== `Bearer ${secret}`) {
    return cronJson({ error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const shard = Number(url.searchParams.get("shard") ?? 0);
  const of = Number(url.searchParams.get("of") ?? 1);
  if (!Number.isInteger(shard) || !Number.isInteger(of) || of < 1 || shard < 0 || shard >= of) {
    return cronJson({ error: "invalid_shard" }, { status: 400 });
  }

  const result = await syncDueConnections(new Date(), {
    shard: of > 1 ? { index: shard, of } : undefined,
    shardIndex,
  });
  // 纯手工 quota 的周期重置（§7.4 / #117）：到期归零、UsageCycleSummary 固化
  const { closed } = await resetDueQuotaCycles(new Date());
  return cronJson({ ok: true, shard, of, cyclesClosed: closed, ...result });
}
