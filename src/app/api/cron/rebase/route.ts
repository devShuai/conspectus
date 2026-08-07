import { NextResponse } from "next/server";

import { db } from "@/server/db";
import { backfillMissingProjections, countMissingProjections } from "@/server/billing/fx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Currency rebase worker: consumes CurrencyRebaseJob rows (sharded by user),
 * backfills projections under the target currency, and only switches
 * User.baseCurrency when the missing-projection count is zero.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const authorization = request.headers.get("authorization");
  const secret = process.env.CRON_SECRET;
  if (!secret || authorization !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const shard = Number(url.searchParams.get("shard") ?? 0);
  const of = Number(url.searchParams.get("of") ?? 1);
  if (of < 1 || shard < 0 || shard >= of) {
    return NextResponse.json({ error: "invalid_shard" }, { status: 400 });
  }

  const jobs = await db.currencyRebaseJob.findMany({
    where: { status: { in: ["pending", "running"] } },
    orderBy: { createdAt: "asc" },
    take: 50,
  });
  const mine = jobs.filter((_, index) => index % of === shard);

  const results: Array<{ jobId: string; status: string; done: number; total: number }> = [];
  for (const job of mine) {
    try {
      const done = await backfillMissingProjections(job.userId, job.toCurrency);
      const missing = await countMissingProjections(job.userId, job.toCurrency);
      if (missing === 0) {
        await db.$transaction(async (tx) => {
          const switched = await tx.currencyRebaseJob.updateMany({
            where: { id: job.id, status: { in: ["pending", "running"] } },
            data: { status: "done", doneCount: job.totalCount },
          });
          if (switched.count === 1) {
            await tx.user.update({
              where: { id: job.userId },
              data: { baseCurrency: job.toCurrency },
            });
          }
        });
        results.push({ jobId: job.id, status: "done", done, total: job.totalCount });
      } else {
        await db.currencyRebaseJob.update({
          where: { id: job.id },
          data: {
            status: "running",
            doneCount: job.doneCount + done,
            totalCount: job.totalCount || missing + job.doneCount + done,
          },
        });
        results.push({ jobId: job.id, status: "running", done, total: job.totalCount });
      }
    } catch (cause) {
      await db.currencyRebaseJob.update({
        where: { id: job.id },
        data: {
          status: "failed",
          lastError: cause instanceof Error ? cause.message.slice(0, 500) : "unknown",
        },
      });
      results.push({ jobId: job.id, status: "failed", done: 0, total: job.totalCount });
    }
  }

  return NextResponse.json({ ok: true, results });
}
