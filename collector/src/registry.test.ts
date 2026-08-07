import { describe, expect, it } from "vitest";

import { listCollectors } from "./collectors/registry";
import type { UsageReading } from "./types";

describe("collector registry", () => {
  it("starts empty and validates reading shape", () => {
    expect(listCollectors()).toEqual([]);
    const reading: UsageReading = {
      bindingId: "00000000-0000-0000-0000-000000000000",
      kind: "quota",
      metric: "requests",
      unit: "req",
      usedValue: "10",
      capturedAt: "2026-01-01T00:00:00Z",
    };
    expect(reading.kind).toBe("quota");
  });
});
