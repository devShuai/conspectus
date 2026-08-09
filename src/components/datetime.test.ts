import { describe, expect, it } from "vitest";

import { formatDate, formatDateTime } from "./datetime";

// 2026-08-08T17:07:05Z = 北京时间 2026-08-09 01:07 = 洛杉矶 2026-08-08 10:07
const SAMPLE = new Date("2026-08-08T17:07:05.000Z");

describe("formatDateTime / formatDate (#78)", () => {
  it("renders in the user's timezone, not UTC", () => {
    expect(formatDateTime(SAMPLE, "Asia/Shanghai")).toBe("2026-08-09 01:07");
    expect(formatDateTime(SAMPLE, "America/Los_Angeles")).toBe("2026-08-08 10:07");
  });

  it("UTC is neither shifted nor hardcoded", () => {
    expect(formatDateTime(SAMPLE, "UTC")).toBe("2026-08-08 17:07");
  });

  it("midnight stays 00:xx (h23), never 24:xx", () => {
    const midnight = new Date("2026-08-08T16:00:00.000Z"); // 北京 00:00
    expect(formatDateTime(midnight, "Asia/Shanghai")).toBe("2026-08-09 00:00");
  });

  it("formatDate takes the calendar date in the user's timezone", () => {
    expect(formatDate(SAMPLE, "Asia/Shanghai")).toBe("2026-08-09");
    expect(formatDate(SAMPLE, "America/Los_Angeles")).toBe("2026-08-08");
  });

  it("falls back to the previous UTC rendering for unknown zones", () => {
    expect(formatDateTime(SAMPLE, "Not/AZone")).toBe("2026-08-08 17:07");
    expect(formatDate(SAMPLE, "Not/AZone")).toBe("2026-08-08");
  });
});
