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

function isMonthAnchored(cycle: BillingCycleKind): boolean {
  return cycle === "monthly" || cycle === "quarterly" || cycle === "yearly";
}

/** 月/季/年周期的锚定日：缺省时从 startedAt 固化（§7.2「必须单独存 anchorDay」）。 */
export function deriveAnchorDay(
  cycle: BillingCycleKind,
  startedAt: Date,
  explicit?: number | null,
): number | null {
  if (explicit !== undefined && explicit !== null) return explicit;
  return isMonthAnchored(cycle) ? startedAt.getUTCDate() : null;
}

/**
 * 计划表上的「下一个未来账期」（§7.2 编辑重算 / paused 恢复口径）：
 * 账期序列 { startedAt + k·cycle | k ≥ 1 } 中第一个 ≥ ref 的日期；
 * O(1) 直算，不落过去 —— 追补（renewals 的 24 期）只服务于任务停摆，
 * 用户主动操作不背锅。lifetime/one_time 返回 null。
 */
export function nextBillingOnOrAfter(
  ref: Date,
  startedAt: Date,
  cycle: BillingCycleKind,
  options: { anchorDay?: number | null; cycleDays?: number | null } = {},
): Date | null {
  if (cycle === "lifetime" || cycle === "one_time") return null;
  const start = new Date(
    Date.UTC(startedAt.getUTCFullYear(), startedAt.getUTCMonth(), startedAt.getUTCDate()),
  );
  const reference = new Date(
    Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate()),
  );

  if (cycle === "weekly" || cycle === "custom") {
    const len = cycle === "weekly" ? 7 : (options.cycleDays ?? 30);
    if (len <= 0) throw new Error("cycleDays must be positive for custom cycle");
    const diffDays = Math.max(
      0,
      Math.floor((reference.getTime() - start.getTime()) / 86_400_000),
    );
    const k = Math.max(1, Math.ceil(diffDays / len));
    return addDays(start, k * len);
  }

  const months = cycle === "monthly" ? 1 : cycle === "quarterly" ? 3 : 12;
  const anchor = deriveAnchorDay(cycle, start, options.anchorDay);
  const dateFor = (k: number): Date => {
    const total = start.getUTCMonth() + k * months;
    const year = start.getUTCFullYear() + Math.floor(total / 12);
    const month = total % 12;
    return new Date(
      Date.UTC(year, month, Math.min(anchor ?? 31, daysInMonth(year, month))),
    );
  };
  const diffMonths =
    (reference.getUTCFullYear() - start.getUTCFullYear()) * 12 +
    (reference.getUTCMonth() - start.getUTCMonth());
  let k = Math.max(1, Math.floor(diffMonths / months));
  // 月末钳制可能让候选早一天，最多再跨一个周期（锚定单调，循环有界）
  for (let guard = 0; guard < 3 && dateFor(k) < reference; guard++) k++;
  return dateFor(k);
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
      // UI marks lifetime as estimate; amortize over 3 years default.
      return price / 3;
    case "one_time":
      // §7.2 无年化口径：一次性付款不折算（此前误按 lifetime 摊销，#105）
      return 0;
  }
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

export function daysInMonth(year: number, monthZeroBased: number): number {
  return new Date(Date.UTC(year, monthZeroBased + 1, 0)).getUTCDate();
}
