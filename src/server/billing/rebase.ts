import { db } from "@/server/db";

import { countMissingProjections } from "./fx";
import { lockUserInTx } from "./user-lock";

export class RebaseError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = "RebaseError";
  }
}

/**
 * 本位币变更入口（design §7.3：「Action 只校验并建行」）：
 * 只创建 pending 任务，切换一律由 /api/cron/rebase 消费者在用户级锁下完成——
 * Action 内不再有「missing=0 立即切换」的快速路径（#108），切换点只有一处，
 * 并发口径只需在 worker 的最终事务里保证。
 */
export async function requestBaseCurrencyChange(input: {
  userId: string;
  toCurrency: string;
}): Promise<{ totalCount: number }> {
  const user = await db.user.findUnique({
    where: { id: input.userId },
    select: { baseCurrency: true },
  });
  if (!user) throw new RebaseError("user_not_found");
  if (user.baseCurrency === input.toCurrency) {
    throw new RebaseError("same_currency");
  }

  return db.$transaction(async (tx) => {
    // 与 paid 入账共用用户级锁：统计缺失数与建行必须在锁下，否则
    // 「数完 100 条后第 101 条只带旧币种投影入账」会漏进 totalCount（§6.2）
    await lockUserInTx(tx, input.userId);
    const activeJob = await tx.currencyRebaseJob.findFirst({
      where: { userId: input.userId, status: { in: ["pending", "running"] } },
    });
    if (activeJob) throw new RebaseError("job_in_flight");

    const missing = await countMissingProjections(input.userId, input.toCurrency, tx);
    await tx.currencyRebaseJob.create({
      data: {
        userId: input.userId,
        fromCurrency: user.baseCurrency,
        toCurrency: input.toCurrency,
        status: "pending",
        totalCount: missing,
      },
    });
    return { totalCount: missing };
  });
}
