import { db } from "@/server/db";

import { countMissingProjections } from "./fx";

export class RebaseError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = "RebaseError";
  }
}

/**
 * 本位币变更入口（design §7.3）：
 * - 已有进行中任务 → 拒绝（每用户至多一个非终态任务）
 * - 无待补投影 → 与 worker 同语义立即切换（job 记 done）
 * - 有待补投影 → 只建队列，由 /api/cron/rebase 分片消费，完成后才切换
 */
export async function requestBaseCurrencyChange(input: {
  userId: string;
  toCurrency: string;
}): Promise<{ switched: boolean; totalCount: number }> {
  const user = await db.user.findUnique({
    where: { id: input.userId },
    select: { baseCurrency: true },
  });
  if (!user) throw new RebaseError("user_not_found");
  if (user.baseCurrency === input.toCurrency) {
    throw new RebaseError("same_currency");
  }

  const activeJob = await db.currencyRebaseJob.findFirst({
    where: { userId: input.userId, status: { in: ["pending", "running"] } },
  });
  if (activeJob) throw new RebaseError("job_in_flight");

  const missing = await countMissingProjections(input.userId, input.toCurrency);
  await db.$transaction(async (tx) => {
    if (missing === 0) {
      await tx.currencyRebaseJob.create({
        data: {
          userId: input.userId,
          fromCurrency: user.baseCurrency,
          toCurrency: input.toCurrency,
          status: "done",
          totalCount: 0,
          doneCount: 0,
        },
      });
      await tx.user.update({
        where: { id: input.userId },
        data: { baseCurrency: input.toCurrency },
      });
    } else {
      await tx.currencyRebaseJob.create({
        data: {
          userId: input.userId,
          fromCurrency: user.baseCurrency,
          toCurrency: input.toCurrency,
          status: "pending",
          totalCount: missing,
        },
      });
    }
  });

  return { switched: missing === 0, totalCount: missing };
}
