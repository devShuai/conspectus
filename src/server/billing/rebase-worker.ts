import { db } from "@/server/db";

import { backfillMissingProjections, countMissingProjections } from "./fx";
import { lockUserInTx } from "./user-lock";

export type RebaseJobResult = {
  jobId: string;
  status: string;
  done: number;
  total: number;
};

/**
 * CurrencyRebaseJob 消费者（design §7.3 / #108）：backfill 目标币种缺失投影，
 * 然后在**用户级锁 + 同一事务**里重新统计缺失数——为 0 才切换 User.baseCurrency；
 * 复核发现 >0 说明 backfill 与切换之间有并发 paid 入账抢入，按 §6.2 不得切换、
 * 任务回 failed 保留现场（用户可重试，重试会再次 backfill 这批记录）。
 */
export async function processRebaseJobs(shard = 0, of = 1): Promise<RebaseJobResult[]> {
  const jobs = await db.currencyRebaseJob.findMany({
    where: { status: { in: ["pending", "running"] } },
    orderBy: { createdAt: "asc" },
    take: 50,
  });
  const mine = jobs.filter((_, index) => index % of === shard);

  const results: RebaseJobResult[] = [];
  for (const job of mine) {
    try {
      const done = await backfillMissingProjections(job.userId, job.toCurrency);
      const preCount = await countMissingProjections(job.userId, job.toCurrency);
      if (preCount > 0) {
        // 汇率暂缺等原因导致 backfill 未完成：保持 running 等下一轮，不算失败
        await db.currencyRebaseJob.update({
          where: { id: job.id },
          data: {
            status: "running",
            doneCount: job.doneCount + done,
            totalCount: job.totalCount || preCount + job.doneCount + done,
          },
        });
        results.push({ jobId: job.id, status: "running", done, total: job.totalCount });
        continue;
      }

      // 最终切换事务：复核与切换同一事务同一锁（§6.2 的硬要求），
      // 分两把锁会在两者之间重新放出并发窗口
      const recheck = await db.$transaction(async (tx) => {
        await lockUserInTx(tx, job.userId);
        const missing = await countMissingProjections(job.userId, job.toCurrency, tx);
        if (missing > 0) return missing;
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
        return 0;
      });
      if (recheck === 0) {
        results.push({ jobId: job.id, status: "done", done, total: job.totalCount });
      } else {
        await db.currencyRebaseJob.update({
          where: { id: job.id },
          data: {
            status: "failed",
            lastError: `projection count changed during switch: ${recheck} missing at recheck`,
          },
        });
        results.push({ jobId: job.id, status: "failed", done: 0, total: job.totalCount });
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
  return results;
}
