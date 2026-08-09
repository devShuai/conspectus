import { db } from "@/server/db";
import { annualizedCost } from "@/server/billing/cycle";
import { countMissingProjections } from "@/server/billing/fx";
import { dateKey, localToday } from "@/server/billing/local-date";

export interface DashboardStats {
  baseCurrency: string;
  monthNetSpend: number;
  annualized: number;
  annualizedUncovered: boolean;
  pendingEstimate: number;
  pendingUncovered: boolean;
  missingProjections: number;
  incomplete: boolean;
  trialCount: number;
  activeCount: number;
  monthRefunds: number;
  monthCharges: number;
}

/**
 * Financial overview for one user in their current base currency (design §7.8).
 * - month net spend = paid charges − paid refunds with billedAt in this month
 * - refunds count in the month they happened (negative)
 * - annualized covers trial + active only (integer multiples)
 * - missing paid projections are NEVER treated as zero: incomplete=true + count
 */
export async function dashboardStats(userId: string): Promise<DashboardStats> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { baseCurrency: true },
  });
  const baseCurrency = user?.baseCurrency ?? "CNY";

  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  const records = await db.billingRecord.findMany({
    where: {
      userId,
      status: "paid",
      billedAt: { gte: monthStart },
    },
    include: { conversions: { where: { baseCurrency } } },
  });

  let monthCharges = 0;
  let monthRefunds = 0;
  let monthNet = 0;
  for (const record of records) {
    const conversion = record.conversions[0];
    if (!conversion) continue; // missing projection: counted below, never 0
    const signed = Number(conversion.signedAmountInBase);
    monthNet += signed;
    if (record.recordType === "refund") monthRefunds += Math.abs(signed);
    else monthCharges += signed;
  }

  const missingProjections = await countMissingProjections(userId, baseCurrency);
  const incomplete = missingProjections > 0;

  // annualized from subscriptions (trial + active only)，按最新可用汇率折到本位币
  // （此前跨币种裸加后按 baseCurrency 显示，#105；one_time 不计入，§7.2 无年化口径）
  const subs = await db.subscription.findMany({
    where: { userId, status: { in: ["trial", "active"] } },
  });

  // pending estimate：设计 §7.3「未来预估支出用当日最新汇率实时算」——
  // pending 按设计不生成投影，逐条用最新汇率折算（此前读不存在的投影，恒为 0）
  const pending = await db.billingRecord.findMany({
    where: { userId, status: "pending" },
    select: { amount: true, currency: true, recordType: true },
  });

  const resolveRate = await latestRateResolver(baseCurrency, [
    ...new Set([...subs.map((s) => s.currency), ...pending.map((r) => r.currency)]),
  ]);

  let annualized = 0;
  let annualizedUncovered = false;
  let trialCount = 0;
  let activeCount = 0;
  for (const sub of subs) {
    const rate = resolveRate(sub.currency);
    if (rate === null) {
      annualizedUncovered = true;
      continue;
    }
    annualized += annualizedCost(Number(sub.price), sub.billingCycle, sub.cycleDays) * rate;
    if (sub.status === "trial") trialCount++;
    else activeCount++;
  }

  let pendingEstimate = 0;
  let pendingUncovered = false;
  for (const record of pending) {
    const rate = resolveRate(record.currency);
    if (rate === null) {
      pendingUncovered = true;
      continue;
    }
    pendingEstimate += Number(record.amount) * rate * (record.recordType === "refund" ? -1 : 1);
  }

  return {
    baseCurrency,
    monthNetSpend: monthNet,
    annualized,
    annualizedUncovered,
    pendingEstimate,
    pendingUncovered,
    missingProjections,
    incomplete,
    trialCount,
    activeCount,
    monthRefunds,
    monthCharges,
  };
}

export interface CalendarDay {
  date: string;
  dueSubscriptions: Array<{ id: string; name: string; amount: number; currency: string }>;
  total: number;
}

/** Billing calendar for a month: due dates from active subscriptions + pending bills. */
export async function billingCalendar(
  userId: string,
  year: number,
  month: number,
): Promise<CalendarDay[]> {
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 1));
  const subs = await db.subscription.findMany({
    where: {
      userId,
      status: { in: ["active", "trial"] },
      nextBillingAt: { gte: start, lt: end },
    },
  });
  const pendings = await db.billingRecord.findMany({
    where: { userId, status: "pending", billedAt: { gte: start, lt: end } },
  });

  const byDate = new Map<string, CalendarDay>();
  for (const sub of subs) {
    const key = sub.nextBillingAt?.toISOString().slice(0, 10) ?? "";
    const day = byDate.get(key) ?? { date: key, dueSubscriptions: [], total: 0 };
    day.dueSubscriptions.push({
      id: sub.id,
      name: sub.name,
      amount: Number(sub.price),
      currency: sub.currency,
    });
    day.total += Number(sub.price);
    byDate.set(key, day);
  }
  for (const pending of pendings) {
    const key = pending.billedAt.toISOString().slice(0, 10);
    const day = byDate.get(key) ?? { date: key, dueSubscriptions: [], total: 0 };
    day.dueSubscriptions.push({
      id: pending.id,
      name: `账单 ${pending.currency} ${pending.amount}`,
      amount: Number(pending.amount),
      currency: pending.currency,
    });
    day.total += Number(pending.amount);
    byDate.set(key, day);
  }

  return [...byDate.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([, day]) => day);
}

export interface UpcomingRenewals {
  days: number;
  count: number; // 窗口内续费笔数（active/trial 的 nextBillingAt）
  nearestDate: string | null; // 最近一笔的日期（YYYY-MM-DD）
  nearestAmounts: Array<{ amount: number; currency: string }>; // 最近一天按币种分列合计
  trialsEnding: number; // 窗口内试用到期数（trialEndsAt）
}

/**
 * 未来 N 天续费（issue #81 / design §4 场景 2）：active/trial 且 nextBillingAt
 * 落在 [用户今天, 今天+N]，与 billingCalendar 同口径（@db.Date，「今天」按用户
 * 时区解析，同 renewals worker）。最近一天的金额按币种分列，不跨币种相加；
 * trialEndsAt 落在窗口内的试用单独计数，供卡片提示「试用即将到期」。
 */
export async function upcomingRenewals(userId: string, days = 7): Promise<UpcomingRenewals> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { timezone: true },
  });
  const today = localToday(new Date(), user?.timezone ?? "UTC");
  const windowEnd = new Date(today.getTime() + days * 86_400_000);

  const subs = await db.subscription.findMany({
    where: {
      userId,
      status: { in: ["active", "trial"] },
      nextBillingAt: { gte: today, lte: windowEnd },
    },
    select: { price: true, currency: true, nextBillingAt: true },
    orderBy: { nextBillingAt: "asc" },
  });

  const nearestDate = subs[0]?.nextBillingAt ? dateKey(subs[0].nextBillingAt) : null;
  const byCurrency = new Map<string, number>();
  for (const sub of subs) {
    if (!sub.nextBillingAt || dateKey(sub.nextBillingAt) !== nearestDate) break;
    byCurrency.set(sub.currency, (byCurrency.get(sub.currency) ?? 0) + Number(sub.price));
  }

  const trialsEnding = await db.subscription.count({
    where: {
      userId,
      status: "trial",
      trialEndsAt: { gte: today, lte: windowEnd },
    },
  });

  return {
    days,
    count: subs.length,
    nearestDate,
    nearestAmounts: [...byCurrency.entries()].map(([currency, amount]) => ({ amount, currency })),
    trialsEnding,
  };
}

/** 最新可用汇率（≤ 今天）；pending 与年化折算共用（§7.3：预估口径用当日最新汇率）。 */
async function latestRateResolver(baseCurrency: string, currencies: string[]) {
  const rates = new Map<string, number>();
  for (const currency of currencies) {
    if (currency === baseCurrency) {
      rates.set(currency, 1);
      continue;
    }
    const row = await db.exchangeRate.findFirst({
      where: { base: currency, quote: baseCurrency },
      orderBy: { date: "desc" },
    });
    if (row) rates.set(currency, Number(row.rate));
  }
  return (currency: string): number | null => rates.get(currency) ?? null;
}

export interface TrendMonth {
  month: string; // "2026-08"（UTC，与 dashboardStats 同口径）
  paid: number; // 实际已付：paid 的 charge+ / refund-（BillingConversion 固化投影）
  pending: number; // 预计将付：pending 按最新汇率估算
  pendingUncovered: boolean; // 有 pending 缺汇率被跳过（绝不静默当 0）
}

/** 近 N 个月趋势（design §7.8）：实际已付与预计将付两个序列。 */
export async function monthlyTrend(userId: string, months = 12): Promise<TrendMonth[]> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { baseCurrency: true },
  });
  const baseCurrency = user?.baseCurrency ?? "CNY";

  const now = new Date();
  const windowStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1), 1));

  const paidRows = await db.$queryRaw<Array<{ month: string; total: number }>>`
    SELECT to_char(date_trunc('month', br."billedAt"), 'YYYY-MM') AS month,
           SUM(bc."signedAmountInBase")::float8 AS total
    FROM "billing_records" br
    JOIN "billing_conversions" bc
      ON bc."billingRecordId" = br.id AND bc."baseCurrency" = ${baseCurrency}
    WHERE br."userId" = ${userId}::uuid
      AND br."status" = 'paid'
      AND br."billedAt" >= ${windowStart}
    GROUP BY 1
  `;

  const pendingRecords = await db.billingRecord.findMany({
    where: { userId, status: "pending" },
    select: { amount: true, currency: true, billedAt: true, recordType: true },
  });
  const resolveRate = await latestRateResolver(
    baseCurrency,
    [...new Set(pendingRecords.map((r) => r.currency))],
  );

  const byMonth = new Map<string, TrendMonth>();
  const slot = (key: string): TrendMonth => {
    let entry = byMonth.get(key);
    if (!entry) {
      entry = { month: key, paid: 0, pending: 0, pendingUncovered: false };
      byMonth.set(key, entry);
    }
    return entry;
  };
  for (const row of paidRows) {
    slot(row.month).paid = row.total;
  }
  for (const record of pendingRecords) {
    const key = record.billedAt.toISOString().slice(0, 7);
    const rate = resolveRate(record.currency);
    const entry = slot(key);
    if (rate === null) {
      entry.pendingUncovered = true;
      continue;
    }
    const signed = Number(record.amount) * rate * (record.recordType === "refund" ? -1 : 1);
    entry.pending += signed;
  }

  const out: TrendMonth[] = [];
  for (let i = months - 1; i >= 0; i--) {
    const ref = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const key = ref.toISOString().slice(0, 7);
    out.push(slot(key));
  }
  return out;
}

export interface CategorySlice {
  category: string;
  annualized: number; // 年化成本（trial + active，最新汇率折算到本位币）
}

/** 分类占比（design §7.8）：按 Vendor.category 的年化成本。 */
export async function categoryBreakdown(
  userId: string,
): Promise<{ slices: CategorySlice[]; uncovered: boolean }> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { baseCurrency: true },
  });
  const baseCurrency = user?.baseCurrency ?? "CNY";

  const subs = await db.subscription.findMany({
    where: { userId, status: { in: ["trial", "active"] } },
    include: { vendor: { select: { category: true } } },
  });
  const resolveRate = await latestRateResolver(
    baseCurrency,
    [...new Set(subs.map((s) => s.currency))],
  );

  const totals = new Map<string, number>();
  let uncovered = false;
  for (const sub of subs) {
    const rate = resolveRate(sub.currency);
    if (rate === null) {
      uncovered = true;
      continue;
    }
    const annualized = annualizedCost(Number(sub.price), sub.billingCycle, sub.cycleDays) * rate;
    const category = sub.vendor?.category ?? "uncategorized";
    totals.set(category, (totals.get(category) ?? 0) + annualized);
  }

  const slices = [...totals.entries()]
    .map(([category, annualized]) => ({ category, annualized }))
    .sort((a, b) => b.annualized - a.annualized);
  return { slices, uncovered };
}
