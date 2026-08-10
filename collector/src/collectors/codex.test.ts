import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  normalizeCodexAppServer,
  normalizeCodexReadings,
  readCodexAppServer,
} from "./codex.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Codex app-server collector", () => {
  it("normalizes official multi-bucket rate limits and lifetime usage", () => {
    const normalized = normalizeCodexAppServer(
      {
        rateLimitsByLimitId: {
          codex: {
            limitId: "codex",
            primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1_780_000_000 },
            secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: 1_780_100_000 },
          },
        },
      },
      { summary: { lifetimeTokens: 1234567 }, dailyUsageBuckets: [] },
    );
    expect(normalized).toEqual({
      rateLimits: [
        {
          limitId: "codex",
          slot: "primary",
          usedPercent: 25,
          windowDurationMins: 300,
          resetsAt: 1_780_000_000,
        },
        {
          limitId: "codex",
          slot: "secondary",
          usedPercent: 40,
          windowDurationMins: 10080,
          resetsAt: 1_780_100_000,
        },
      ],
      lifetimeTokens: 1234567,
    });
  });

  it("maps common durations and exact buckets only to manifest bindings", () => {
    const readings = normalizeCodexReadings(
      {
        rateLimits: [
          { limitId: "codex", slot: "primary", usedPercent: 25, windowDurationMins: 300, resetsAt: 1_780_000_000 },
          { limitId: "codex_other", slot: "primary", usedPercent: 42, windowDurationMins: 60, resetsAt: 1_780_000_000 },
        ],
        lifetimeTokens: 1000,
      },
      [
        { bindingId: "5h", metric: "codex:5h", kind: "quota", unit: "%" },
        { bindingId: "other", metric: "codex:codex_other:primary", kind: "quota", unit: "%" },
        { bindingId: "tokens", metric: "codex:tokens", kind: "counter", unit: "tok" },
      ],
      "2026-08-10T10:00:00Z",
    );
    expect(readings.map((reading) => reading.bindingId)).toEqual(["5h", "other", "tokens"]);
    expect(readings[0]).toMatchObject({ usedValue: "25", limitValue: "100" });
    expect(readings[2]).toMatchObject({ usedValue: "1000", unit: "tok" });
  });

  /*
   * 实测账号上 app-server 同时返回 codex(9%) 与 codex_bengalfox(0%)，两者
   * windowDurationMins 都是 10080。此前两个窗口都命中同一条 codex:weekly，一批里
   * 对同一 binding 推两条读数；capturedAt 相同，ingest 在同刻并列时用随机 UUID
   * 决胜，于是真实的 9% 被 0% 顶掉，方向还偏向「以为还没用」。
   */
  it("does not let a non-canonical bucket collide onto codex:weekly", () => {
    const readings = normalizeCodexReadings(
      {
        rateLimits: [
          { limitId: "codex_bengalfox", slot: "primary", usedPercent: 0, windowDurationMins: 10080, resetsAt: 1_780_000_000 },
          { limitId: "codex", slot: "primary", usedPercent: 9, windowDurationMins: 10080, resetsAt: 1_780_000_000 },
        ],
        lifetimeTokens: null,
      },
      [{ bindingId: "weekly", metric: "codex:weekly", kind: "quota", unit: "%" }],
      "2026-08-10T10:00:00Z",
    );
    expect(readings).toHaveLength(1);
    expect(readings[0]).toMatchObject({ bindingId: "weekly", usedValue: "9" });
  });

  it("still exposes a non-canonical bucket through its exact metric", () => {
    const readings = normalizeCodexReadings(
      {
        rateLimits: [
          { limitId: "codex_bengalfox", slot: "primary", usedPercent: 3, windowDurationMins: 10080, resetsAt: 1_780_000_000 },
        ],
        lifetimeTokens: null,
      },
      [
        { bindingId: "bengal", metric: "codex:codex_bengalfox:primary", kind: "quota", unit: "%" },
      ],
      "2026-08-10T10:00:00Z",
    );
    expect(readings).toHaveLength(1);
    expect(readings[0]).toMatchObject({ bindingId: "bengal", usedValue: "3" });
  });

  it("performs initialize + initialized + both account requests over stdio JSONL", async () => {
    const directory = resolve(tmpdir(), `conspectus-codex-${Date.now()}-${Math.random()}`);
    directories.push(directory);
    mkdirSync(directory, { recursive: true });
    const fake = resolve(directory, "fake-app-server.mjs");
    writeFileSync(
      fake,
      `import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
let initialized = false;
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") process.stdout.write(JSON.stringify({ id: msg.id, result: { userAgent: "fake" } }) + "\\n");
  else if (msg.method === "initialized") initialized = true;
  else if (!initialized) process.stdout.write(JSON.stringify({ id: msg.id, error: { message: "Not initialized" } }) + "\\n");
  else if (msg.method === "account/rateLimits/read") process.stdout.write(JSON.stringify({ id: msg.id, result: { rateLimits: { limitId: "codex", primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 1780000000 } } } }) + "\\n");
  else if (msg.method === "account/usage/read") process.stdout.write(JSON.stringify({ id: msg.id, result: { summary: { lifetimeTokens: 99 } } }) + "\\n");
});`,
    );
    await expect(readCodexAppServer(process.execPath, [fake], 3_000)).resolves.toMatchObject({
      rateLimits: [{ limitId: "codex", usedPercent: 10 }],
      lifetimeTokens: 99,
    });
  });
});
