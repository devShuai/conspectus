import { describe, expect, it } from "vitest";

import { nextSyncDelayMs } from "./sync.js";

describe("sync backoff", () => {
  it("steps 1h → 4h → 12h and caps", () => {
    expect(nextSyncDelayMs(0, null)).toBe(1 * 3600_000);
    expect(nextSyncDelayMs(1, null)).toBe(4 * 3600_000);
    expect(nextSyncDelayMs(2, null)).toBe(12 * 3600_000);
    expect(nextSyncDelayMs(9, null)).toBe(12 * 3600_000);
  });

  it("respects Retry-After within bounds", () => {
    expect(nextSyncDelayMs(0, 90_000)).toBe(90_000);
    expect(nextSyncDelayMs(0, 500)).toBe(60_000); // floor 1min
    expect(nextSyncDelayMs(0, 20 * 3600_000)).toBe(12 * 3600_000); // cap 12h
  });
});
