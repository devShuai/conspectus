import { describe, expect, it } from "vitest";

import {
  burnRatePerDay,
  projectBalanceDaysLeft,
  projectQuotaExhaustion,
} from "./insights";

const DAY = 86_400_000;
const NOW = new Date("2026-08-07T00:00:00Z");

function points(series: Array<[dayOffset: number, value: number]>) {
  return series.map(([d, v]) => ({
    capturedAt: new Date(NOW.getTime() + d * DAY),
    value: v,
  }));
}

describe("burnRatePerDay", () => {
  it("single point or single instant returns null", () => {
    expect(burnRatePerDay(points([[0, 10]]))).toBeNull();
    expect(
      burnRatePerDay([
        { capturedAt: NOW, value: 10 },
        { capturedAt: NOW, value: 20 },
      ]),
    ).toBeNull();
  });

  it("steady burn gives the right slope regardless of input order", () => {
    // 每天 +5，乱序输入不影响结果
    const rate = burnRatePerDay(points([[4, 30], [0, 10], [2, 20]]));
    expect(rate).toBeCloseTo(5);
  });

  it("noisy series fits a least-squares slope", () => {
    // 围绕每天 +10 抖动
    const rate = burnRatePerDay(
      points([[0, 0], [1, 12], [2, 18], [3, 31], [4, 39]]),
    );
    expect(rate).toBeCloseTo(10, 0);
  });

  it("flat or falling readings return null (no exhaustion to project)", () => {
    expect(burnRatePerDay(points([[0, 50], [1, 50], [2, 50]]))).toBeNull();
    // 反向读数（周期重置后更低、或来源纠错）
    expect(burnRatePerDay(points([[0, 50], [1, 40], [2, 30]]))).toBeNull();
  });
});

describe("projectQuotaExhaustion", () => {
  const periodEnd = new Date(NOW.getTime() + 20 * DAY);

  it("projects days until exhausted and days before period end", () => {
    // 每天用 5，已用 50 / 100 → 还剩 10 天；周期 20 天后结束 → 早 10 天用完
    const projection = projectQuotaExhaustion(points([[-4, 30], [-2, 40], [0, 50]]), {
      used: 50,
      limit: 100,
      periodEnd,
      now: NOW,
    });
    expect(projection?.daysUntilExhausted).toBeCloseTo(10);
    expect(projection?.daysBeforePeriodEnd).toBeCloseTo(10);
  });

  it("returns null daysBeforePeriodEnd when the period renews first", () => {
    // 每天只 +1：50 天后才耗尽，周期 20 天后重置 → 本周期用不完
    const projection = projectQuotaExhaustion(points([[-2, 48], [0, 50]]), {
      used: 50,
      limit: 100,
      periodEnd,
      now: NOW,
    });
    expect(projection?.daysUntilExhausted).toBeCloseTo(50);
    expect(projection?.daysBeforePeriodEnd).toBeNull();
  });

  it("already exhausted reports 0 without needing a rate", () => {
    const projection = projectQuotaExhaustion([], {
      used: 100,
      limit: 100,
      periodEnd,
      now: NOW,
    });
    expect(projection?.daysUntilExhausted).toBe(0);
    expect(projection?.daysBeforePeriodEnd).toBeCloseTo(20);
  });

  it("new period with a single reading cannot project yet", () => {
    expect(
      projectQuotaExhaustion(points([[0, 5]]), {
        used: 5,
        limit: 100,
        periodEnd,
        now: NOW,
      }),
    ).toBeNull();
  });

  it("missing or non-positive limit returns null", () => {
    expect(
      projectQuotaExhaustion(points([[-1, 1], [0, 2]]), {
        used: 2,
        limit: 0,
        periodEnd,
        now: NOW,
      }),
    ).toBeNull();
  });
});

describe("projectBalanceDaysLeft", () => {
  it("burns down to days left", () => {
    // 余额每天 -2，还剩 30 → 约 15 天
    const days = projectBalanceDaysLeft(points([[-3, 36], [-1, 32], [0, 30]]), {
      remaining: 30,
    });
    expect(days).toBeCloseTo(15);
  });

  it("empty balance is 0 days without a rate", () => {
    expect(projectBalanceDaysLeft([], { remaining: 0 })).toBe(0);
  });

  it("topped-up or untouched balance cannot project", () => {
    // 充值后余额回升
    expect(
      projectBalanceDaysLeft(points([[-2, 10], [0, 100]]), { remaining: 100 }),
    ).toBeNull();
    // 只有一条快照
    expect(projectBalanceDaysLeft(points([[0, 30]]), { remaining: 30 })).toBeNull();
  });
});
