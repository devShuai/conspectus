import type { PrismaClient } from "@prisma/client";

import { db } from "@/server/db";

export class FxError extends Error {
  constructor(
    public readonly code: "unsupported_currency" | "upstream_failure",
    message: string,
  ) {
    super(message);
    this.name = "FxError";
  }
}

const FRANKFURTER_BASE = "https://api.frankfurter.app";
const SUPPORTED_BASE = new Set(["CNY", "USD", "EUR", "GBP", "JPY", "HKD", "AUD", "CAD", "SGD", "CHF"]);

/** Manual rate source marker for user-provided rates. */
export const MANUAL_RATE_SOURCE = "manual";

export function isSupportedCurrency(currency: string): boolean {
  return SUPPORTED_BASE.has(currency);
}

/**
 * Fetch a fix for (base, quote) at the latest date ≤ requested date from
 * Frankfurter/ECB. Falls back to the nearest previous business day.
 * Returns null when no rate is available (e.g. weekend/holiday before any fix).
 */
export async function fetchFxRate(
  base: string,
  quote: string,
  date: Date,
): Promise<{ rate: number; fxDate: Date } | null> {
  if (!isSupportedCurrency(base) || !isSupportedCurrency(quote)) {
    throw new FxError("unsupported_currency", `unsupported currency ${base}/${quote}`);
  }
  const yyyy = date.toISOString().slice(0, 10);
  const url = `${FRANKFURTER_BASE}/${yyyy}..?from=${base}&to=${quote}`;
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) {
    throw new FxError("upstream_failure", `frankfurter returned ${response.status}`);
  }
  const body = (await response.json()) as {
    rates?: Record<string, Record<string, number>>;
  };
  const dates = Object.keys(body.rates ?? {}).sort();
  if (dates.length === 0) return null;
  const lastDate = dates[dates.length - 1];
  const rate = body.rates?.[lastDate]?.[quote];
  if (typeof rate !== "number") return null;
  return { rate, fxDate: new Date(`${lastDate}T00:00:00Z`) };
}

/** Persist a fetched rate. */
export async function saveFxRate(
  date: Date,
  base: string,
  quote: string,
  rate: number,
): Promise<void> {
  await db.exchangeRate.upsert({
    where: { date_base_quote: { date, base, quote } },
    create: { date, base, quote, rate },
    update: { rate },
  });
}

/**
 * 每日抓取的币种对（design §7.3「用户实际用到的币种对」）：
 * 每个用户的本位币 × 全部使用币种（账单 paid/pending + 订阅 + 用户本位币）。
 * 此前只取最早一个用户的本位币当全局 quote，其他本位币用户的投影永远补不上（#93）。
 */
export async function collectFxPairs(): Promise<Array<{ base: string; quote: string }>> {
  const used = await db.$queryRaw<Array<{ currency: string }>>`
    SELECT DISTINCT currency FROM "billing_records" WHERE "status" IN ('paid', 'pending')
    UNION
    SELECT DISTINCT currency FROM "subscriptions"
    UNION
    SELECT DISTINCT "baseCurrency" AS currency FROM "users"
  `;
  const quoteRows = await db.user.findMany({
    select: { baseCurrency: true },
    distinct: ["baseCurrency"],
  });
  const pairs: Array<{ base: string; quote: string }> = [];
  for (const { baseCurrency: quote } of quoteRows) {
    for (const { currency: base } of used) {
      if (base !== quote) pairs.push({ base, quote });
    }
  }
  return pairs;
}

/** Count paid records missing a projection for the user's base currency. */
export async function countMissingProjections(
  userId: string,
  baseCurrency: string,
  client: Pick<PrismaClient, "$queryRaw"> = db,
): Promise<number> {
  const missing = await client.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*)::bigint AS count
    FROM "billing_records" br
    WHERE br."userId" = ${userId}::uuid
      AND br."status" = 'paid'
      AND NOT EXISTS (
        SELECT 1 FROM "billing_conversions" bc
        WHERE bc."billingRecordId" = br.id AND bc."baseCurrency" = ${baseCurrency}
      )
  `;
  return Number(missing[0]?.count ?? 0);
}

/** Rebuild projections for paid records missing them under target base currency. */
export async function backfillMissingProjections(
  userId: string,
  toCurrency: string,
): Promise<number> {
  const paid = await db.billingRecord.findMany({
    where: {
      userId,
      status: "paid",
      conversions: { none: { baseCurrency: toCurrency } },
    },
  });
  let done = 0;
  for (const record of paid) {
    const signed = Number(record.amount) * (record.recordType === "refund" ? -1 : 1);
    if (record.currency === toCurrency) {
      await db.billingConversion.create({
        data: {
          userId,
          billingRecordId: record.id,
          baseCurrency: toCurrency,
          signedAmountInBase: signed,
          fxRate: 1,
          fxDate: record.billedAt,
          rateSource: "provider",
        },
      });
      done++;
      continue;
    }
    const row = await db.exchangeRate.findFirst({
      where: {
        base: record.currency,
        quote: toCurrency,
        date: { lte: record.billedAt },
      },
      orderBy: { date: "desc" },
    });
    if (!row) continue; // still missing; retry later
    await db.billingConversion.create({
      data: {
        userId,
        billingRecordId: record.id,
        baseCurrency: toCurrency,
        signedAmountInBase: signed * Number(row.rate),
        fxRate: Number(row.rate),
        fxDate: row.date,
        rateSource: "provider",
      },
    });
    done++;
  }
  return done;
}
