import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  BUFFER_LIMITS,
  bufferStats,
  clearBuffer,
  enqueueFailedBatch,
  pendingBatches,
  removeBatch,
} from "./buffer.js";
import type { UsageReading } from "./types.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "conspectus-buffer-"));
  process.env.CONSPECTUS_CONFIG_DIR = dir;
});

afterEach(() => {
  delete process.env.CONSPECTUS_CONFIG_DIR;
  rmSync(dir, { recursive: true, force: true });
});

function reading(bindingId: string, capturedAt = "2026-01-01T00:00:00.000Z"): UsageReading {
  return {
    bindingId,
    kind: "quota",
    metric: "requests",
    unit: "req",
    usedValue: "1",
    capturedAt,
  };
}

describe("report buffer", () => {
  it("persists failed batches and replays them oldest-first", () => {
    const first = enqueueFailedBatch([reading("b1")], "network down");
    const second = enqueueFailedBatch([reading("b2")], "500");
    const pending = pendingBatches();
    expect(pending.map((b) => b.id)).toEqual([first.id, second.id]);
    expect(pending[0].readings[0].bindingId).toBe("b1");
    expect(pending[0].lastError).toBe("network down");
  });

  it("removeBatch deletes exactly one batch; clearBuffer empties all", () => {
    const a = enqueueFailedBatch([reading("b1")], "e1");
    const b = enqueueFailedBatch([reading("b2")], "e2");
    removeBatch(a.id);
    expect(pendingBatches().map((x) => x.id)).toEqual([b.id]);
    clearBuffer();
    expect(pendingBatches()).toEqual([]);
  });

  it("drops batches older than the retention window", () => {
    const stale = enqueueFailedBatch([reading("old")], "e");
    enqueueFailedBatch([reading("new")], "e");
    // age the first batch beyond retention by rewriting the file
    const file = join(dir, "pending-reports.json");
    const raw = JSON.parse(readFileSync(file, "utf8")) as {
      batches: Array<{ id: string; enqueuedAt: string }>;
    };
    raw.batches[0].enqueuedAt = new Date(
      Date.now() - BUFFER_LIMITS.retentionMs - 1000,
    ).toISOString();
    writeFileSync(file, JSON.stringify(raw));
    const pending = pendingBatches();
    expect(pending.find((b) => b.id === stale.id)).toBeUndefined();
    expect(pending).toHaveLength(1);
  });

  it("evicts oldest batches when the batch cap is exceeded", () => {
    for (let i = 0; i < BUFFER_LIMITS.maxBatches + 5; i++) {
      enqueueFailedBatch([reading(`b${i}`)], "e");
    }
    const pending = pendingBatches();
    expect(pending.length).toBe(BUFFER_LIMITS.maxBatches);
    // the five oldest are gone; the newest survives
    expect(pending[pending.length - 1].readings[0].bindingId).toBe(
      `b${BUFFER_LIMITS.maxBatches + 4}`,
    );
  });

  it("evicts oldest batches when the total readings cap is exceeded", () => {
    const big = Math.ceil(BUFFER_LIMITS.maxReadings / 2) + 1;
    enqueueFailedBatch(Array.from({ length: big }, (_, i) => reading(`a${i}`)), "e");
    enqueueFailedBatch(Array.from({ length: big }, (_, i) => reading(`c${i}`)), "e");
    const pending = pendingBatches();
    expect(pending).toHaveLength(1); // oldest evicted to fit the readings cap
    expect(pending[0].readings[0].bindingId).toBe("c0");
  });

  it("treats a corrupt buffer file as empty instead of crashing", () => {
    writeFileSync(join(dir, "pending-reports.json"), "{not json");
    expect(pendingBatches()).toEqual([]);
    expect(bufferStats()).toEqual({
      batches: 0,
      readings: 0,
      oldestEnqueuedAt: null,
      lastError: null,
    });
  });

  it("writes the buffer with owner-only permissions", () => {
    enqueueFailedBatch([reading("b1")], "e");
    const mode = statSync(join(dir, "pending-reports.json")).mode & 0o777;
    if (process.platform !== "win32") expect(mode).toBe(0o600);
  });

  it("bufferStats summarizes depth, age and last error", () => {
    enqueueFailedBatch([reading("b1"), reading("b2")], "first error");
    enqueueFailedBatch([reading("b3")], "last error");
    const stats = bufferStats();
    expect(stats.batches).toBe(2);
    expect(stats.readings).toBe(3);
    expect(stats.oldestEnqueuedAt).toMatch(/^\d{4}-/);
    expect(stats.lastError).toBe("last error");
  });
});
