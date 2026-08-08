import { describe, expect, it } from "vitest";

import { db } from "@/server/db";

import { recordPaidCharge } from "./billing";
import { RebaseError, requestBaseCurrencyChange } from "./rebase";
import { processRebaseJobs } from "./rebase-worker";

const DISABLED = !process.env.TEST_DATABASE_URL;

function unique(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function makeUser(sub: string) {
  return db.user.create({
    data: { certusSub: sub, certusLinkStatus: "active", lastStatusSyncedAt: new Date() },
  });
}

async function makeSubscription(userId: string) {
  return db.subscription.create({
    data: {
      userId,
      name: "Netflix",
      status: "active",
      price: 138,
      currency: "CNY",
      billingCycle: "monthly",
      startedAt: new Date("2026-01-01T00:00:00Z"),
    },
  });
}

async function jobOf(userId: string) {
  return db.currencyRebaseJob.findFirstOrThrow({ where: { userId } });
}

describe.skipIf(DISABLED)("requestBaseCurrencyChange + rebase worker (#71/#108)", () => {
  it("rejects the same currency", async () => {
    const user = await makeUser(unique("rebase-1"));
    await expect(
      requestBaseCurrencyChange({ userId: user.id, toCurrency: "CNY" }),
    ).rejects.toThrow(RebaseError);
    await db.user.delete({ where: { id: user.id } });
  });

  it("action only queues; the worker switches after rechecking under the user lock", async () => {
    const user = await makeUser(unique("rebase-2"));
    // Action 只校验并建行（§7.3）：即使无缺失投影也不在 Action 内切换
    const result = await requestBaseCurrencyChange({ userId: user.id, toCurrency: "USD" });
    expect(result.totalCount).toBe(0);
    let job = await jobOf(user.id);
    expect(job.status).toBe("pending");
    expect(job.totalCount).toBe(0);
    let after = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.baseCurrency).toBe("CNY");

    // 消费者：backfill 空转 → 锁下复核 0 → 切换
    const results = await processRebaseJobs();
    const mine = results.find((r) => r.jobId === job.id);
    expect(mine?.status).toBe("done");
    job = await jobOf(user.id);
    expect(job.status).toBe("done");
    after = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.baseCurrency).toBe("USD");

    await db.user.delete({ where: { id: user.id } });
  });

  it("queues a job when projections are missing and keeps base currency until done", async () => {
    const user = await makeUser(unique("rebase-3"));
    const sub = await makeSubscription(user.id);
    await db.billingRecord.create({
      data: {
        userId: user.id,
        subscriptionId: sub.id,
        amount: 138,
        currency: "CNY",
        recordType: "charge",
        billedAt: new Date("2026-02-01T00:00:00Z"),
        status: "paid",
        source: "manual",
      },
    });

    const result = await requestBaseCurrencyChange({ userId: user.id, toCurrency: "USD" });
    expect(result.totalCount).toBe(1);

    const job = await jobOf(user.id);
    expect(job.status).toBe("pending");
    expect(job.totalCount).toBe(1);
    // 完成前不切换（design §7.3：查询永远只读到一套完整口径）
    const after = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.baseCurrency).toBe("CNY");

    await db.user.delete({ where: { id: user.id } });
  });

  it("rejects a second job while one is in flight", async () => {
    const user = await makeUser(unique("rebase-4"));
    await db.currencyRebaseJob.create({
      data: {
        userId: user.id,
        fromCurrency: "CNY",
        toCurrency: "EUR",
        status: "pending",
        totalCount: 1,
      },
    });
    await expect(
      requestBaseCurrencyChange({ userId: user.id, toCurrency: "USD" }),
    ).rejects.toThrow(RebaseError);
    await db.user.delete({ where: { id: user.id } });
  });

  it("barrier: a paid charge committed between count and switch fails the job instead of mixing currencies", async () => {
    const user = await makeUser(unique("rebase-5"));
    const sub = await makeSubscription(user.id);
    await requestBaseCurrencyChange({ userId: user.id, toCurrency: "USD" });
    const job = await jobOf(user.id);

    // 并发入账：在事务内持用户锁写入 paid 记录（投影落在旧本位币 CNY），
    // 锁住不放，让 worker 的 preCount 读到 0 后在最终事务的锁上等待
    const charge = db.$transaction(async (tx) => {
      await recordPaidCharge(
        {
          userId: user.id,
          subscriptionId: sub.id,
          amount: 138,
          currency: "CNY",
          billedAt: new Date("2026-08-01T00:00:00Z"),
          source: "manual",
        },
        tx,
      );
      await new Promise((resolve) => setTimeout(resolve, 1500));
    });
    // 让入账事务先拿到锁
    await new Promise((resolve) => setTimeout(resolve, 200));
    const results = await processRebaseJobs();
    await charge;

    const mine = results.find((r) => r.jobId === job.id);
    expect(mine?.status).toBe("failed");
    const afterJob = await jobOf(user.id);
    expect(afterJob.status).toBe("failed");
    expect(afterJob.lastError).toContain("recheck");
    // 不得切换：口径不串（§6.2）
    const after = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.baseCurrency).toBe("CNY");

    await db.user.delete({ where: { id: user.id } });
  });
});
