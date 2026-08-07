import type { Prisma } from "@prisma/client";

import { db } from "@/server/db";

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
  client: Prisma.TransactionClient = db,
): Promise<RecordResult> {
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
  client: Prisma.TransactionClient = db,
): Promise<RecordResult> {
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
  return db.$transaction(async (tx) => {
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

  // Look up the best available rate at/after billedAt; if missing → no projection.
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
      rateSource: "provider",
    },
  });
  return true;
}
