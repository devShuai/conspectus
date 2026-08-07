import { describe, expect, it, vi } from "vitest";

import { isSupportedCurrency } from "./fx.js";

describe("fx module", () => {
  it("marks supported currencies", () => {
    expect(isSupportedCurrency("CNY")).toBe(true);
    expect(isSupportedCurrency("USD")).toBe(true);
    expect(isSupportedCurrency("XYZ")).toBe(false);
  });
});

void vi;
