export type BillingCycleKind =
  | "weekly"
  | "monthly"
  | "quarterly"
  | "yearly"
  | "custom"
  | "lifetime"
  | "one_time";

export interface BillingCycleInput {
  cycle: BillingCycleKind;
  anchorDay?: number | null;
  cycleDays?: number | null;
}

/**
 * Compute the next billing date (design.md §7.2):
 * - weekly → +7 days
 * - custom → +cycleDays days
 * - monthly/quarterly/yearly → calendar-month math, day = min(anchorDay, days in target month)
 *   (anchor 29–31 clamp at month end and never drift down permanently)
 * - lifetime/one_time → null
 * Dates are treated as UTC midnight to avoid TZ drift.
 */
export function nextBillingDate(
  from: Date,
  cycle: BillingCycleKind,
  options: { anchorDay?: number | null; cycleDays?: number | null } = {},
): Date | null {
  const anchorDay = options.anchorDay ?? null;
  const cycleDays = options.cycleDays ?? null;

  if (cycle === "lifetime" || cycle === "one_time") {
    return null;
  }
  if (cycle === "weekly") {
    return addDays(from, 7);
  }
  if (cycle === "custom") {
    const days = cycleDays ?? 30;
    if (days <= 0) throw new Error("cycleDays must be positive for custom cycle");
    return addDays(from, days);
  }

  const anchor = anchorDay ?? from.getUTCDate();
  const months =
    cycle === "monthly" ? 1 : cycle === "quarterly" ? 3 : 12;
  const targetYear = from.getUTCFullYear();
  const targetMonthZero = from.getUTCMonth() + months;
  const year = targetYear + Math.floor(targetMonthZero / 12);
  const month = targetMonthZero % 12; // 0-based
  const daysInTargetMonth = daysInMonth(year, month);
  const day = Math.min(anchor, daysInTargetMonth);
  return new Date(Date.UTC(year, month, day));
}

/**
 * Monthly/annualized cost (design.md §7.2): monthly×12, quarterly×4, yearly×1
 * (integer multiples, not 365/cycle); weekly/custom use price × 365/cycleLength.
 */
export function annualizedCost(
  price: number,
  cycle: BillingCycleKind,
  cycleDays?: number | null,
): number {
  switch (cycle) {
    case "monthly":
      return price * 12;
    case "quarterly":
      return price * 4;
    case "yearly":
      return price;
    case "weekly":
      return price * (365 / 7);
    case "custom": {
      const days = cycleDays ?? 30;
      return price * (365 / days);
    }
    case "lifetime":
    case "one_time":
      // UI marks lifetime/one-time as estimate; amortize over 3 years default.
      return price / 3;
  }
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

export function daysInMonth(year: number, monthZeroBased: number): number {
  return new Date(Date.UTC(year, monthZeroBased + 1, 0)).getUTCDate();
}
