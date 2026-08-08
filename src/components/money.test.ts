import { describe, expect, it } from "vitest";

import { formatMoney } from "./money";

describe("formatMoney (#73)", () => {
  it("formats CNY with symbol and two decimals", () => {
    expect(formatMoney(1234.5, "CNY")).toBe("¥1,234.50");
  });

  it("formats USD with its own symbol and thousands separator", () => {
    expect(formatMoney(1234.5, "USD")).toBe("US$1,234.50");
  });

  it("JPY has no fraction digits (toFixed(2) would be wrong)", () => {
    // zh-CN 下 JPY 显示为 JP¥ 以区别于人民币 ¥；关键是无小数位
    expect(formatMoney(1234.5, "JPY")).toBe("JP¥1,235");
  });

  it("falls back to raw code for unknown currencies instead of misattributing", () => {
    // 非 ISO-4217 形式（含数字）Intl 抛 RangeError → 回退为原代码
    expect(formatMoney(12.3456, "XX1")).toBe("12.35 XX1");
  });

  it("never hardcodes the CNY symbol for other currencies", () => {
    const out = formatMoney(100, "EUR");
    expect(out).not.toContain("¥");
    expect(out).toContain("€");
  });
});
