import { db } from "@/server/db";
import { annualizedCost } from "@/server/billing/cycle";
import { countMissingProjections } from "@/server/billing/fx";

export interface DashboardStats {
  monthNetSpend: number;
  annualized: number;
  pendingEstimate: number;
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

  // annualized from subscriptions (trial + active only)
  const subs = await db.subscription.findMany({
    where: { userId, status: { in: ["trial", "active"] } },
  });
  let annualized = 0;
  let trialCount = 0;
  let activeCount = 0;
  for (const sub of subs) {
    const cycle = sub.billingCycle;
    annualized += annualizedCost(Number(sub.price), cycle, sub.cycleDays);
    if (sub.status === "trial") trialCount++;
    else activeCount++;
  }

  // pending estimate (future, today's rate implicit — flagged as estimate)
  const pending = await db.billingRecord.findMany({
    where: { userId, status: "pending" },
    include: { conversions: { where: { baseCurrency } } },
  });
  let pendingEstimate = 0;
  for (const record of pending) {
    const conversion = record.conversions[0];
    if (!conversion) continue;
    pendingEstimate += Number(conversion.signedAmountInBase);
  }

  return {
    monthNetSpend: monthNet,
    annualized,
    pendingEstimate,
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
