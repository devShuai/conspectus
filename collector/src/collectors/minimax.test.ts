import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { minimaxCollector } from "./minimax.js";

const BINDINGS = [
  { bindingId: "bind-5h", metric: "minimax:5h", kind: "quota", unit: "req" },
  { bindingId: "bind-weekly", metric: "minimax:weekly", kind: "quota", unit: "req" },
];

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

beforeEach(() => {
  process.env.CONSPECTUS_MINIMAX_ENABLED = "true";
  process.env.MINIMAX_API_KEY = "test-key";
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.CONSPECTUS_MINIMAX_ENABLED;
  delete process.env.MINIMAX_API_KEY;
  delete process.env.MINIMAX_HOST;
});

describe("minimaxCollector", () => {
  it("count variant: used = total - remaining (community reads fields as REMAINING)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ status: 1, total: 100, remaining: 30, reset_at: "2026-01-02T00:00:00Z" }),
      ),
    );
    const readings = await minimaxCollector.collect({ bindings: BINDINGS });
    expect(readings).toHaveLength(2);
    expect(readings[0]).toMatchObject({
      bindingId: "bind-5h",
      kind: "quota",
      unit: "req",
      usedValue: "70",
      limitValue: "100",
      periodEnd: "2026-01-02T00:00:00Z",
    });
  });

  it("percentage variant: usage_percentage is normalized to a 0-100 quota", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ status: 1, usage_percentage: 42 })),
    );
    const readings = await minimaxCollector.collect({ bindings: BINDINGS });
    expect(readings).toHaveLength(2);
    expect(readings[0]).toMatchObject({
      unit: "%",
      usedValue: "42",
      limitValue: "100",
    });
  });

  it("rejects out-of-range percentage as schema drift", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ status: 1, usage_percentage: 250 })),
    );
    await expect(minimaxCollector.collect({ bindings: BINDINGS })).rejects.toThrow(
      "schema drift",
    );
  });

  it("missing both variants is schema drift", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ status: 1 })));
    await expect(minimaxCollector.collect({ bindings: BINDINGS })).rejects.toThrow(
      "schema drift",
    );
  });

  it("http failure does not leak the response body into the error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ secret: "sensitive" }, 500)),
    );
    await expect(minimaxCollector.collect({ bindings: BINDINGS })).rejects.toThrow(
      "minimax remains 500",
    );
    await expect(minimaxCollector.collect({ bindings: BINDINGS })).rejects.not.toThrow(
      "sensitive",
    );
  });
});
