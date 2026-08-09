import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { registerCollector } from "./registry.js";
import { runAllCollectors } from "./runner.js";
import type { UsageReading } from "../types.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "conspectus-runner-"));
  process.env.CONSPECTUS_CONFIG_DIR = dir;
});

afterEach(() => {
  delete process.env.CONSPECTUS_CONFIG_DIR;
  rmSync(dir, { recursive: true, force: true });
});

function reading(bindingId: string): UsageReading {
  return {
    bindingId,
    kind: "quota",
    metric: "requests",
    unit: "req",
    usedValue: "1",
    capturedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("runAllCollectors", () => {
  it("isolates a failing collector and delivers only each collector's own bindings", async () => {
    const seenBy: Record<string, string[]> = {};
    registerCollector({
      id: "ok-one",
      displayName: "ok",
      detect: async () => true,
      collect: async (ctx) => {
        seenBy["ok-one"] = ctx.bindings.map((b) => b.bindingId);
        return [reading("b-ok")];
      },
    });
    registerCollector({
      id: "bad-one",
      displayName: "bad",
      detect: async () => true,
      collect: async () => {
        throw new Error("boom");
      },
    });
    registerCollector({
      id: "no-bindings",
      displayName: "skip",
      detect: async () => {
        throw new Error("detect must not even run without bindings");
      },
      collect: async () => [reading("never")],
    });

    const { readings, statuses } = await runAllCollectors([
      { bindingId: "b-ok", collectorId: "ok-one", metric: "m", kind: "quota", unit: "req" },
      { bindingId: "b-bad", collectorId: "bad-one", metric: "m", kind: "quota", unit: "req" },
    ]);

    expect(readings.map((r) => r.bindingId)).toEqual(["b-ok"]);
    expect(seenBy["ok-one"]).toEqual(["b-ok"]); // not b-bad
    const byId = Object.fromEntries(statuses.map((s) => [s.id, s]));
    expect(byId["ok-one"].ok).toBe(true);
    expect(byId["bad-one"]).toMatchObject({ ok: false, error: "boom", readings: 0 });
    expect(byId["no-bindings"]).toBeUndefined(); // skipped entirely
  });
});
