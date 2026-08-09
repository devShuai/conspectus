import { describe, expect, it } from "vitest";

import { isSupportedCurrency, pickLatestFixOnOrBefore } from "./fx";

describe("isSupportedCurrency", () => {
  it("covers the frankfurter upstream set, not a hardcoded subset (#106)", () => {
    expect(isSupportedCurrency("CNY")).toBe(true);
    expect(isSupportedCurrency("USD")).toBe(true);
    // 此前硬编码 10 币种时被误伤的上游币种
    expect(isSupportedCurrency("KRW")).toBe(true);
    expect(isSupportedCurrency("INR")).toBe(true);
    expect(isSupportedCurrency("BRL")).toBe(true);
    expect(isSupportedCurrency("XYZ")).toBe(false);
  });
});

describe("pickLatestFixOnOrBefore", () => {
  const rates = {
    "2026-01-13": { CNY: 7.1 },
    "2026-01-14": { CNY: 7.2 },
    "2026-01-16": { CNY: 7.3 },
  };

  it("picks the exact date when a fix exists", () => {
    const result = pickLatestFixOnOrBefore(rates, "CNY", new Date("2026-01-14T00:00:00Z"));
    expect(result?.rate).toBe(7.2);
    expect(result?.fxDate).toEqual(new Date("2026-01-14T00:00:00Z"));
  });

  it("falls back to the previous business day", () => {
    const result = pickLatestFixOnOrBefore(rates, "CNY", new Date("2026-01-15T00:00:00Z"));
    expect(result?.rate).toBe(7.2);
    expect(result?.fxDate).toEqual(new Date("2026-01-14T00:00:00Z"));
  });

  it("never picks a fix after the requested date (#106)", () => {
    // 2026-01-15 之后有 01-16 的 fix，但 fxDate 必须 ≤ 请求日期
    const result = pickLatestFixOnOrBefore(rates, "CNY", new Date("2026-01-15T00:00:00Z"));
    expect(result?.fxDate).toEqual(new Date("2026-01-14T00:00:00Z"));
  });

  it("returns null when no fix is ≤ the requested date", () => {
    expect(pickLatestFixOnOrBefore(rates, "CNY", new Date("2026-01-12T00:00:00Z"))).toBeNull();
  });

  it("returns null when the quote is missing on the latest eligible date", () => {
    expect(
      pickLatestFixOnOrBefore({ "2026-01-13": { EUR: 0.9 } }, "CNY", new Date("2026-01-13T00:00:00Z")),
    ).toBeNull();
  });
});
