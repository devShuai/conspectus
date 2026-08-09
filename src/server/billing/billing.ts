import type { Prisma } from "@prisma/client";

import { db } from "@/server/db";

import { ensureFxRate, isSupportedCurrency, MANUAL_RATE_SOURCE } from "./fx";
import { lockUserInTx } from "./user-lock";

export class BillingError extends Error {
  constructor(
    public readonly code:
      | "subscription_not_found"
      | "refund_invalid"
      | "refund_exceeds"
      | "invalid_input",
    message: string,
  ) {
    super(message);
    this.name = "BillingError";
  }
}

export interface RecordPaymentInput {
  userId: string;
  subscriptionId: string;
  amount: number;
  currency: string;
  billedAt: Date;
  source: "manual" | "email" | "csv" | "system";
  status?: "paid";
  externalRef?: string | null;
  periodStart?: Date | null;
  periodEnd?: Date | null;
  fxRate?: number | null;
  fxDate?: Date | null;
}

export interface RecordRefundInput {
  userId: string;
  subscriptionId: string;
  originalRecordId: string;
  amount: number;
  currency: string;
  billedAt: Date;
  source: "manual" | "email" | "csv";
  externalRef?: string | null;
}

export interface RecordResult {
  billingRecordId: string;
  projected: boolean;
}

/**
 * Unified paid-billing entry point (design.md §6.2 / §7.3):
 * - charge/refund facts are immutable in original currency
 * - refunds validate original (same user/sub/currency, paid, total ≤ original)
 * - projections are written ONLY for paid records, in the same transaction
 * - missing fx rate → record stored WITHOUT projection, marked incomplete
 *   (never silently treated as 0)
 */
export async function recordPaidCharge(
  input: RecordPaymentInput,
  client?: Prisma.TransactionClient,
): Promise<RecordResult> {
  if (client) return recordPaidChargeImpl(input, client);
  // 汇率就绪必须在锁/事务之外完成（§7.3，#106）：网络调用绝不进持锁事务（#108）。
  // 调用方自管事务时需自行保证汇率已就绪。
  await prepareFxForPayment(input.userId, input.currency, input.billedAt, input.fxRate);
  // 默认必须包事务：记录与投影是一个原子事实（§6.2），不是两条独立语句
  return db.$transaction((tx) => recordPaidChargeImpl(input, tx));
}

async function recordPaidChargeImpl(
  input: RecordPaymentInput,
  client: Prisma.TransactionClient,
): Promise<RecordResult> {
  // 与 rebase 切换共用用户级锁（§6.2）：写投影与「统计缺失并切币种」串行化
  await lockUserInTx(client, input.userId);
  const sub = await client.subscription.findFirst({
    where: { id: input.subscriptionId, userId: input.userId },
  });
  if (!sub) throw new BillingError("subscription_not_found", "subscription not found");

  const record = await client.billingRecord.create({
    data: {
      userId: input.userId,
      subscriptionId: input.subscriptionId,
      amount: input.amount,
      currency: input.currency,
      recordType: "charge",
      billedAt: input.billedAt,
      periodStart: input.periodStart ?? null,
      periodEnd: input.periodEnd ?? null,
      status: "paid",
      source: input.source,
      externalRef: input.externalRef ?? null,
    },
  });

  const projected = await writeProjection(
    client,
    input.userId,
    record.id,
    input.amount,
    input.currency,
    input.billedAt,
    input.fxRate,
    input.fxDate,
  );
  return { billingRecordId: record.id, projected };
}

export async function recordRefund(
  input: RecordRefundInput,
  client?: Prisma.TransactionClient,
): Promise<RecordResult> {
  if (client) return recordRefundImpl(input, client);
  // 同 recordPaidCharge：按需抓取在锁/事务之外（§7.3 / #108）
  await prepareFxForPayment(input.userId, input.currency, input.billedAt, null);
  // 默认必须包事务（§6.2 退款关系约束：「同一事务锁定原记录后校验」）——
  // 否则 FOR UPDATE 语句一提交锁就释放，并发退款可双双通过上限校验
  return db.$transaction((tx) => recordRefundImpl(input, tx));
}

async function recordRefundImpl(
  input: RecordRefundInput,
  client: Prisma.TransactionClient,
): Promise<RecordResult> {
  await lockUserInTx(client, input.userId);
  const original = await client.billingRecord.findFirst({
    where: {
      id: input.originalRecordId,
      userId: input.userId,
      subscriptionId: input.subscriptionId,
      recordType: "charge",
      status: "paid",
    },
  });
  if (!original) {
    throw new BillingError("refund_invalid", "original charge not found");
  }
  if (original.currency !== input.currency) {
    throw new BillingError("refund_invalid", "currency mismatch with original");
  }

  // Lock the original row for the refund-sum check (concurrent-safe).
  const lockRows = await client.$queryRaw<
    Array<{ id: string }>
  >`SELECT id FROM "billing_records" WHERE id = ${original.id}::uuid FOR UPDATE`;
  if (lockRows.length !== 1) {
    throw new BillingError("refund_invalid", "original charge vanished");
  }

  const aggregated = await client.billingRecord.aggregate({
    where: {
      originalRecordId: original.id,
      recordType: "refund",
      status: "paid",
    },
    _sum: { amount: true },
  });
  const refundedSoFar = Number(aggregated._sum.amount ?? 0);
  if (refundedSoFar + input.amount > Number(original.amount)) {
    throw new BillingError("refund_exceeds", "refund total exceeds original charge");
  }

  const refund = await client.billingRecord.create({
    data: {
      userId: input.userId,
      subscriptionId: input.subscriptionId,
      amount: input.amount,
      currency: input.currency,
      recordType: "refund",
      originalRecordId: original.id,
      billedAt: input.billedAt,
      status: "paid",
      source: input.source,
      externalRef: input.externalRef ?? null,
    },
  });

  const projected = await writeProjection(
    client,
    input.userId,
    refund.id,
    -input.amount,
    input.currency,
    input.billedAt,
  );
  return { billingRecordId: refund.id, projected };
}

/** pending → paid (confirm expected charge, e.g. acceptDraft / user confirm). */
export async function confirmPendingCharge(
  userId: string,
  billingRecordId: string,
  input: { amount?: number; billedAt?: Date },
): Promise<RecordResult> {
  // 事务外预读确定生效的币种/日期，先完成按需抓取（§7.3 / #108）；
  // 记录不存在则跳过，由事务内抛出统一错误
  const existing = await db.billingRecord.findFirst({
    where: { id: billingRecordId, userId, status: "pending", recordType: "charge" },
    select: { currency: true, billedAt: true },
  });
  if (existing) {
    await prepareFxForPayment(userId, existing.currency, input.billedAt ?? existing.billedAt, null);
  }
  return db.$transaction(async (tx) => {
    await lockUserInTx(tx, userId);
    const record = await tx.billingRecord.findFirst({
      where: { id: billingRecordId, userId, status: "pending", recordType: "charge" },
    });
    if (!record) {
      throw new BillingError("invalid_input", "pending charge not found");
    }
    const amount = input.amount ?? Number(record.amount);
    const billedAt = input.billedAt ?? record.billedAt;
    await tx.billingRecord.update({
      where: { id: record.id },
      data: { status: "paid", amount, billedAt },
    });
    const projected = await writeProjection(
      tx,
      userId,
      record.id,
      amount,
      record.currency,
      billedAt,
    );
    return { billingRecordId: record.id, projected };
  });
}

/**
 * §7.3 汇率就绪（事务外）：
 * - 汇率源不覆盖的币种必须自带固定汇率（投影 rateSource=manual），否则录入即
 *   拒绝 —— 绝不静默按 0 计入统计，也不留一条永远补不上的待换算投影（#106）
 * - 覆盖币种缺行时事务外按需抓取落表（best-effort，抓不到由 fx cron 补齐）
 */
async function prepareFxForPayment(
  userId: string,
  currency: string,
  billedAt: Date,
  fxRate?: number | null,
): Promise<void> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { baseCurrency: true },
  });
  const baseCurrency = user?.baseCurrency ?? "CNY";
  if (currency === baseCurrency) return;
  if (!isSupportedCurrency(currency) || !isSupportedCurrency(baseCurrency)) {
    if (fxRate === undefined || fxRate === null) {
      throw new BillingError(
        "invalid_input",
        `currency ${currency} is not covered by the fx source; provide a manual fxRate`,
      );
    }
    return;
  }
  if (fxRate !== undefined && fxRate !== null) return;
  await ensureFxRate(currency, baseCurrency, billedAt);
}

async function writeProjection(
  client: Prisma.TransactionClient,
  userId: string,
  billingRecordId: string,
  signedAmount: number,
  currency: string,
  billedAt: Date,
  fxRate?: number | null,
  fxDate?: Date | null,
): Promise<boolean> {
  const user = await client.user.findUnique({
    where: { id: userId },
    select: { baseCurrency: true },
  });
  const baseCurrency = user?.baseCurrency ?? "CNY";
  if (currency === baseCurrency) {
    await client.billingConversion.create({
      data: {
        userId,
        billingRecordId,
        baseCurrency,
        signedAmountInBase: signedAmount,
        fxRate: 1,
        fxDate: billedAt,
        rateSource: "provider",
      },
    });
    return true;
  }

  // Look up the best available rate at/before billedAt; if missing → no projection.
  const manualRate = fxRate !== undefined && fxRate !== null;
  let rate = fxRate;
  let rateDate = fxDate ?? billedAt;
  if (rate === undefined || rate === null) {
    const row = await client.exchangeRate.findFirst({
      where: { base: currency, quote: baseCurrency, date: { lte: billedAt } },
      orderBy: { date: "desc" },
    });
    if (row) {
      rate = Number(row.rate);
      rateDate = row.date;
    }
  }
  if (rate === undefined || rate === null) {
    return false; // incomplete projection; caller may mark for later rebase
  }
  await client.billingConversion.create({
    data: {
      userId,
      billingRecordId,
      baseCurrency,
      signedAmountInBase: signedAmount * rate,
      fxRate: rate,
      fxDate: rateDate,
      // 调用方手填的固定汇率必须标记 manual（§7.3，#106），不得冒充 provider
      rateSource: manualRate ? MANUAL_RATE_SOURCE : "provider",
    },
  });
  return true;
}
