import { NextResponse } from "next/server";

import { db } from "@/server/db";
import {
  backfillMissingProjections,
  collectFxPairs,
  fetchFxRate,
  markLatestFxStale,
  saveFxRate,
} from "@/server/billing/fx";

import { cronJson } from "../json";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Daily FX fetch (06:00 UTC) for currencies actually used by users,
 * then backfill missing projections for pending rebase jobs / incomplete records.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const authorization = request.headers.get("authorization");
  const secret = process.env.CRON_SECRET;
  if (!secret || authorization !== `Bearer ${secret}`) {
    return cronJson({ error: "unauthorized" }, { status: 401 });
  }

  const today = new Date();
  // design §7.3：每个用户的本位币 × 全部使用币种（此前只用一个全局 quote，#93）
  const pairs = await collectFxPairs();

  let fetched = 0;
  let stale = 0;
  for (const pair of pairs) {
    try {
      const result = await fetchFxRate(pair.base, pair.quote, today);
      if (result) {
        await saveFxRate(result.fxDate, pair.base, pair.quote, result.rate);
        fetched++;
      } else {
        // 无新 fix（不该常见）：回退到上一个可用日期并标记 stale（§7.3，#106）
        if (await markFxStaleSafe(pair.base, pair.quote, today)) stale++;
      }
    } catch {
      // individual pair failure should not abort the whole run;
      // 回退到上一个可用日期的汇率并标记 stale（§7.3，#106）
      if (await markFxStaleSafe(pair.base, pair.quote, today)) stale++;
    }
  }

  // Backfill projections for users whose rebase job is pending/running or records incomplete.
  const users = await db.user.findMany({ select: { id: true, baseCurrency: true } });
  let backfilled = 0;
  for (const user of users) {
    backfilled += await backfillMissingProjections(user.id, user.baseCurrency);
  }

  return cronJson({ ok: true, fetched, stale, backfilled });
}

/** 回退标记自身失败（DB 抖动等）不放大为整批失败。 */
async function markFxStaleSafe(base: string, quote: string, date: Date): Promise<boolean> {
  try {
    return await markLatestFxStale(base, quote, date);
  } catch {
    return false;
  }
}
