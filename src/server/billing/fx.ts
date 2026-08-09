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
/**
 * frankfurter 上游实际覆盖的币种集（ECB 参考汇率，https://api.frankfurter.app/currencies）。
 * 此前硬编码 10 币种，KRW/INR/BRL 等被误伤（#106）；ECB 列表极稳定，直接内置，
 * 上游扩容时同步更新本集合即可。
 */
const UPSTREAM_CURRENCIES = new Set([
  "AUD", "BGN", "BRL", "CAD", "CHF", "CNY", "CZK", "DKK", "EUR", "GBP",
  "HKD", "HUF", "IDR", "ILS", "INR", "ISK", "JPY", "KRW", "MXN", "MYR",
  "NOK", "NZD", "PHP", "PLN", "RON", "SEK", "SGD", "THB", "TRY", "USD",
  "ZAR",
]);

/** Manual rate source marker for user-provided rates. */
export const MANUAL_RATE_SOURCE = "manual";

export function isSupportedCurrency(currency: string): boolean {
  return UPSTREAM_CURRENCIES.has(currency);
}

/** 区间查询的回看窗口：覆盖周末 + ECB 假日空窗，取 ≤ 目标日的最近 fix 足够用。 */
const LOOKBACK_DAYS = 21;

/**
 * 从区间响应里取 ≤ date 的最近一个 fix（§7.3：fxDate 取 ≤ billedAt 的最近可得
 * 日期，绝不取更晚的）。纯函数，供 fetchFxRate 与单测共用。
 */
export function pickLatestFixOnOrBefore(
  rates: Record<string, Record<string, number>>,
  quote: string,
  date: Date,
): { rate: number; fxDate: Date } | null {
  const limit = date.toISOString().slice(0, 10);
  const eligible = Object.keys(rates)
    .filter((d) => d <= limit)
    .sort();
  const lastDate = eligible[eligible.length - 1];
  if (!lastDate) return null;
  const rate = rates[lastDate]?.[quote];
  if (typeof rate !== "number") return null;
  return { rate, fxDate: new Date(`${lastDate}T00:00:00Z`) };
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
  const end = date.toISOString().slice(0, 10);
  const startDate = new Date(date);
  startDate.setUTCDate(startDate.getUTCDate() - LOOKBACK_DAYS);
  const start = startDate.toISOString().slice(0, 10);
  const url = `${FRANKFURTER_BASE}/${start}..${end}?from=${base}&to=${quote}`;
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) {
    throw new FxError("upstream_failure", `frankfurter returned ${response.status}`);
  }
  const body = (await response.json()) as {
    rates?: Record<string, Record<string, number>>;
  };
  return pickLatestFixOnOrBefore(body.rates ?? {}, quote, date);
}

/** Persist a fetched rate; a fresh fix resets the stale fallback marker. */
export async function saveFxRate(
  date: Date,
  base: string,
  quote: string,
  rate: number,
): Promise<void> {
  await db.exchangeRate.upsert({
    where: { date_base_quote: { date, base, quote } },
    create: { date, base, quote, rate, stale: false },
    update: { rate, stale: false },
  });
}

/**
 * 抓取失败时的回退标记（§7.3）：投影查询本就取 ≤ date 的最近一行，「回退」天然
 * 成立，这里把该行标记为 stale 以暴露「当前用的是旧汇率」。无可回退行返回 false。
 */
export async function markLatestFxStale(
  base: string,
  quote: string,
  date: Date,
): Promise<boolean> {
  const row = await db.exchangeRate.findFirst({
    where: { base, quote, date: { lte: date } },
    orderBy: { date: "desc" },
  });
  if (!row || row.stale) return false;
  await db.exchangeRate.update({
    where: { date_base_quote: { date: row.date, base, quote } },
    data: { stale: true },
  });
  return true;
}

/**
 * 事务外按需抓取（§7.3「汇率就绪」）：入账事务只读 ExchangeRate 表，缺行时先在
 * 锁/事务之外抓历史 fix 落表（frankfurter 支持历史日期）。永远 best-effort——
 * 抓不到则账单照存、投影入待补集合由 cron 补齐，绝不阻塞记账。
 */
export async function ensureFxRate(
  base: string,
  quote: string,
  date: Date,
): Promise<void> {
  if (base === quote) return;
  try {
    const row = await db.exchangeRate.findFirst({
      where: { base, quote, date: { lte: date } },
      select: { date: true },
    });
    if (row) return;
    const result = await fetchFxRate(base, quote, date);
    if (result) await saveFxRate(result.fxDate, base, quote, result.rate);
  } catch {
    // 抓取失败 → 投影待补，由 fx 每日任务补齐（§7.3）
  }
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
