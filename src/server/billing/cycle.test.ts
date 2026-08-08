import { describe, expect, it } from "vitest";

import { annualizedCost, nextBillingDate, nextBillingOnOrAfter } from "./cycle";

describe("nextBillingDate", () => {
  it("advances monthly by one calendar month", () => {
    expect(nextBillingDate(new Date("2026-01-15T00:00:00Z"), "monthly")).toEqual(
      new Date("2026-02-15T00:00:00Z"),
    );
  });

  it("clamps Jan 31 to Feb 28/29 without permanent drift", () => {
    const feb = nextBillingDate(new Date("2026-01-31T00:00:00Z"), "monthly", {
      anchorDay: 31,
    });
    expect(feb).toEqual(new Date("2026-02-28T00:00:00Z"));
    const mar = nextBillingDate(new Date("2026-02-28T00:00:00Z"), "monthly", {
      anchorDay: 31,
    });
    expect(mar).toEqual(new Date("2026-03-31T00:00:00Z"));
    const apr = nextBillingDate(new Date("2026-03-31T00:00:00Z"), "monthly", {
      anchorDay: 31,
    });
    expect(apr).toEqual(new Date("2026-04-30T00:00:00Z"));
  });

  it("handles leap years (2028 Feb has 29 days)", () => {
    expect(
      nextBillingDate(new Date("2028-01-31T00:00:00Z"), "monthly", {
        anchorDay: 31,
      }),
    ).toEqual(new Date("2028-02-29T00:00:00Z"));
  });

  it("advances quarterly and yearly", () => {
    expect(
      nextBillingDate(new Date("2026-03-31T00:00:00Z"), "quarterly", {
        anchorDay: 31,
      }),
    ).toEqual(new Date("2026-06-30T00:00:00Z"));
    expect(
      nextBillingDate(new Date("2026-02-28T00:00:00Z"), "yearly", {
        anchorDay: 28,
      }),
    ).toEqual(new Date("2027-02-28T00:00:00Z"));
  });

  it("handles weekly, custom, and one_time/lifetime", () => {
    expect(nextBillingDate(new Date("2026-01-01T00:00:00Z"), "weekly")).toEqual(
      new Date("2026-01-08T00:00:00Z"),
    );
    expect(
      nextBillingDate(new Date("2026-01-01T00:00:00Z"), "custom", {
        cycleDays: 30,
      }),
    ).toEqual(new Date("2026-01-31T00:00:00Z"));
    expect(nextBillingDate(new Date("2026-01-01T00:00:00Z"), "one_time")).toBeNull();
    expect(nextBillingDate(new Date("2026-01-01T00:00:00Z"), "lifetime")).toBeNull();
  });
});

describe("annualizedCost", () => {
  it("uses integer multiples for month/quarter/year", () => {
    expect(annualizedCost(100, "monthly")).toBe(1200);
    expect(annualizedCost(100, "quarterly")).toBe(400);
    expect(annualizedCost(100, "yearly")).toBe(100);
  });

  it("uses 365/cycle for weekly/custom", () => {
    expect(annualizedCost(7, "weekly")).toBeCloseTo(365, 5);
    expect(annualizedCost(30, "custom", 30)).toBeCloseTo(365, 5);
  });

  it("amortizes lifetime over 3 years; one_time is not annualized (#105)", () => {
    expect(annualizedCost(3000, "lifetime")).toBeCloseTo(1000, 5);
    expect(annualizedCost(3000, "one_time")).toBe(0);
  });
});

describe("nextBillingOnOrAfter (#104)", () => {
  const ref = new Date("2026-08-08T00:00:00Z");

  it("returns the first scheduled date on/after ref (monthly)", () => {
    expect(
      nextBillingOnOrAfter(ref, new Date("2026-01-15T00:00:00Z"), "monthly"),
    ).toEqual(new Date("2026-08-15T00:00:00Z"));
  });

  it("keeps the 31st anchor instead of drifting down", () => {
    expect(
      nextBillingOnOrAfter(ref, new Date("2026-01-31T00:00:00Z"), "monthly"),
    ).toEqual(new Date("2026-08-31T00:00:00Z"));
    // 锚定日恰好在 ref 上时取当天（on/after 含等号）
    expect(
      nextBillingOnOrAfter(
        new Date("2026-02-28T00:00:00Z"),
        new Date("2026-01-31T00:00:00Z"),
        "monthly",
      ),
    ).toEqual(new Date("2026-02-28T00:00:00Z"));
  });

  it("skips a full cycle when month-end clamping lands before ref (quarterly)", () => {
    expect(
      nextBillingOnOrAfter(
        new Date("2026-05-01T00:00:00Z"),
        new Date("2026-01-31T00:00:00Z"),
        "quarterly",
      ),
    ).toEqual(new Date("2026-07-31T00:00:00Z"));
  });

  it("jumps whole years without iterating (yearly)", () => {
    expect(
      nextBillingOnOrAfter(ref, new Date("2026-01-15T00:00:00Z"), "yearly"),
    ).toEqual(new Date("2027-01-15T00:00:00Z"));
  });

  it("weekly/custom step from startedAt in whole periods", () => {
    expect(
      nextBillingOnOrAfter(ref, new Date("2026-01-01T00:00:00Z"), "weekly"),
    ).toEqual(new Date("2026-08-13T00:00:00Z"));
    expect(
      nextBillingOnOrAfter(
        new Date("2026-01-09T00:00:00Z"),
        new Date("2026-01-01T00:00:00Z"),
        "weekly",
      ),
    ).toEqual(new Date("2026-01-15T00:00:00Z"));
    expect(
      nextBillingOnOrAfter(ref, new Date("2026-01-01T00:00:00Z"), "custom", {
        cycleDays: 30,
      }),
    ).toEqual(new Date("2026-08-29T00:00:00Z"));
  });

  it("matches creation semantics when startedAt is still ahead", () => {
    expect(
      nextBillingOnOrAfter(ref, new Date("2026-09-01T00:00:00Z"), "monthly"),
    ).toEqual(new Date("2026-10-01T00:00:00Z"));
  });

  it("returns null for lifetime/one_time", () => {
    expect(nextBillingOnOrAfter(ref, new Date("2026-01-15T00:00:00Z"), "lifetime")).toBeNull();
    expect(nextBillingOnOrAfter(ref, new Date("2026-01-15T00:00:00Z"), "one_time")).toBeNull();
  });
});
