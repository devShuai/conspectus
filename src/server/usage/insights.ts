/**
 * 用量洞察（design §7.4 / #118）：基于最近 N 个快照做最小二乘线性外推。
 * 纯函数模块 —— 不 import db，调用方（用量页 / 规则求值）自行查询快照后传入。
 *
 * 快照语义（ingest.ts）：quota/counter 的 value = 已用量（递增），
 * balance 的 value = 剩余量（递减）；周期重置后 quota 读数归零，调用方
 * 应只传当前周期内的点（capturedAt >= periodStart），否则斜率被重置污染。
 */

export type SnapshotPoint = { capturedAt: Date; value: number };

const DAY_MS = 86_400_000;

/** 参与拟合的最近快照数；更多旧点只会稀释近期速率。 */
export const PROJECTION_WINDOW = 14;

/**
 * 最小二乘斜率（单位/天），points 任意顺序。
 * 返回 null 的情形：不同时间点 < 2 个、斜率 ≤ 0（无消耗 / 读数反向回落）——
 * 这些都无法外推耗尽，硬算只会给出负数或无穷大。
 */
export function burnRatePerDay(points: SnapshotPoint[]): number | null {
  const sorted = [...points]
    .sort((a, b) => a.capturedAt.getTime() - b.capturedAt.getTime())
    .slice(-PROJECTION_WINDOW);
  const n = sorted.length;
  if (n < 2) return null;

  const xs = sorted.map((p) => p.capturedAt.getTime() / DAY_MS);
  const ys = sorted.map((p) => p.value);
  const meanX = xs.reduce((s, x) => s + x, 0) / n;
  const meanY = ys.reduce((s, y) => s + y, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - meanX;
    sxx += dx * dx;
    sxy += dx * (ys[i]! - meanY);
  }
  if (sxx === 0) return null; // 全部同一时刻，无速率可言
  const slope = sxy / sxx;
  return slope > 0 ? slope : null;
}

export type QuotaProjection = {
  /** 距耗尽的天数（已耗尽为 0） */
  daysUntilExhausted: number;
  /** 预计耗尽时刻 */
  exhaustAt: Date;
  /**
   * 耗尽比周期结束早多少天；本周期内用不完（含无 periodEnd）为 null ——
   * 周期先重置就没有「用完」可言，告警与 UI 都不该再报。
   */
  daysBeforePeriodEnd: number | null;
};

/**
 * quota 外推：当前 used 相对 limit 的剩余容量 ÷ 消耗速率。
 * 已耗尽时不依赖速率直接给 0；limit ≤ 0 或速率不可得返回 null。
 */
export function projectQuotaExhaustion(
  points: SnapshotPoint[],
  opts: { used: number; limit: number; periodEnd: Date | null; now: Date },
): QuotaProjection | null {
  if (!(opts.limit > 0)) return null;
  if (opts.used >= opts.limit) {
    const exhausted: QuotaProjection = {
      daysUntilExhausted: 0,
      exhaustAt: opts.now,
      daysBeforePeriodEnd: null,
    };
    if (opts.periodEnd && opts.periodEnd.getTime() > opts.now.getTime()) {
      exhausted.daysBeforePeriodEnd =
        (opts.periodEnd.getTime() - opts.now.getTime()) / DAY_MS;
    }
    return exhausted;
  }
  const rate = burnRatePerDay(points);
  if (rate === null) return null;
  const days = (opts.limit - opts.used) / rate;
  const exhaustAt = new Date(opts.now.getTime() + days * DAY_MS);
  const daysBeforePeriodEnd =
    opts.periodEnd && opts.periodEnd.getTime() > exhaustAt.getTime()
      ? (opts.periodEnd.getTime() - exhaustAt.getTime()) / DAY_MS
      : null;
  return { daysUntilExhausted: days, exhaustAt, daysBeforePeriodEnd };
}

/**
 * balance 外推：剩余量 ÷ 消耗速率 = 约可用天数。
 * 通过对剩余量取负复用递增拟合；余额回升（充值）或不动返回 null。
 */
export function projectBalanceDaysLeft(
  points: SnapshotPoint[],
  opts: { remaining: number },
): number | null {
  if (opts.remaining <= 0) return 0;
  const rate = burnRatePerDay(
    points.map((p) => ({ capturedAt: p.capturedAt, value: -p.value })),
  );
  if (rate === null) return null;
  return opts.remaining / rate;
}
