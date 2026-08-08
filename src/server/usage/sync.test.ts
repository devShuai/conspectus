import { describe, expect, it } from "vitest";

import { DEGRADED_PROBE_MS, nextSyncDelayMs, syncDelayForFailure } from "./sync";

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

  it("probes every 24h once degraded (#107)", () => {
    expect(syncDelayForFailure(1, null)).toBe(1 * 3600_000); // 第 1 次失败 → 1h
    expect(syncDelayForFailure(2, null)).toBe(4 * 3600_000); // 第 2 次失败 → 4h
    expect(syncDelayForFailure(3, null)).toBe(DEGRADED_PROBE_MS); // 第 3 次 → degraded 24h 探测
    expect(syncDelayForFailure(9, null)).toBe(DEGRADED_PROBE_MS);
    expect(syncDelayForFailure(3, 60_000)).toBe(DEGRADED_PROBE_MS); // retryAfter 不再覆盖 24h 探测
  });
});
