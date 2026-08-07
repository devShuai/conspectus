import { NextResponse } from "next/server";

import { db } from "@/server/db";
import { backfillMissingProjections, countMissingProjections, fetchFxRate, saveFxRate } from "@/server/billing/fx";

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
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const today = new Date();
  const currencies = await db.$queryRaw<Array<{ currency: string }>>`
    SELECT DISTINCT currency FROM "billing_records" WHERE status = 'paid'
    UNION
    SELECT DISTINCT base_currency FROM "users"
  `;
  const pairs: Array<{ base: string; quote: string }> = [];
  const baseCurrency = await db.user.findFirst({
    select: { baseCurrency: true },
    orderBy: { createdAt: "asc" },
  });
  const quote = baseCurrency?.baseCurrency ?? "CNY";
  for (const { currency } of currencies) {
    if (currency !== quote && !pairs.some((p) => p.base === currency && p.quote === quote)) {
      pairs.push({ base: currency, quote });
    }
  }

  let fetched = 0;
  for (const pair of pairs) {
    try {
      const result = await fetchFxRate(pair.base, pair.quote, today);
      if (result) {
        await saveFxRate(result.fxDate, pair.base, pair.quote, result.rate);
        fetched++;
      }
    } catch {
      // individual pair failure should not abort the whole run
    }
  }

  // Backfill projections for users whose rebase job is pending/running or records incomplete.
  const users = await db.user.findMany({ select: { id: true, baseCurrency: true } });
  let backfilled = 0;
  for (const user of users) {
    backfilled += await backfillMissingProjections(user.id, user.baseCurrency);
  }

  return NextResponse.json({ ok: true, fetched, backfilled });
}
