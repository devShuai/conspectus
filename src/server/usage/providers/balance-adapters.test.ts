import { describe, expect, it } from "vitest";

import { listBalanceAdapters } from "./balance-adapters.js";

describe("balance adapters", () => {
  it("registers the three balance providers", () => {
    const adapters = listBalanceAdapters();
    expect(adapters.map((a) => a.id).sort()).toEqual(["deepseek", "kimi", "xai"]);
  });
});
