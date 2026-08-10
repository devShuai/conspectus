import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseKimiUsage, readKimiAccessToken } from "./kimi.js";

const BINDINGS = [
  { bindingId: "weekly", metric: "kimi:weekly", kind: "quota", unit: "req" },
  { bindingId: "5h", metric: "kimi:5h", kind: "quota", unit: "req" },
  { bindingId: "other", metric: "claude:five_hour", kind: "quota", unit: "%" },
];

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Kimi Code collector", () => {
  it("parses the official weekly summary and 300-minute window", () => {
    const readings = parseKimiUsage(
      {
        usage: { used: "40", limit: "1000", resetTime: "2026-08-17T00:00:00Z" },
        limits: [
          {
            window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
            detail: { used: "10", limit: "100", resetTime: "2026-08-10T15:00:00Z" },
          },
        ],
      },
      BINDINGS,
      "2026-08-10T10:00:00Z",
    );
    expect(readings).toEqual([
      expect.objectContaining({
        bindingId: "weekly",
        metric: "kimi:weekly",
        usedValue: "40",
        limitValue: "1000",
        periodStart: "2026-08-10T00:00:00.000Z",
      }),
      expect.objectContaining({
        bindingId: "5h",
        metric: "kimi:5h",
        usedValue: "10",
        limitValue: "100",
        periodStart: "2026-08-10T10:00:00.000Z",
      }),
    ]);
  });

  it("degrades independently when only the weekly window is present", () => {
    const readings = parseKimiUsage(
      { usage: { used: 1, limit: 20, resetTime: "2026-08-17T00:00:00Z" } },
      BINDINGS,
      "2026-08-10T10:00:00Z",
    );
    expect(readings).toHaveLength(1);
    expect(readings[0].metric).toBe("kimi:weekly");
  });

  it("only emits readings for manifest bindings", () => {
    const readings = parseKimiUsage(
      {
        usage: { used: 1, limit: 20 },
        limits: [
          {
            window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
            detail: { used: 2, limit: 10 },
          },
        ],
      },
      [BINDINGS[1]],
      "2026-08-10T10:00:00Z",
    );
    expect(readings.map((reading) => reading.metric)).toEqual(["kimi:5h"]);
  });

  it("reads a valid native token without exposing the refresh token", () => {
    const directory = resolve(tmpdir(), `conspectus-kimi-${Date.now()}-${Math.random()}`);
    directories.push(directory);
    mkdirSync(directory, { recursive: true });
    const path = resolve(directory, "kimi-code.json");
    writeFileSync(
      path,
      JSON.stringify({
        access_token: "access-only",
        refresh_token: "must-not-be-returned",
        expires_at: 2_000_000_000,
      }),
    );
    expect(readKimiAccessToken(path, 1_900_000_000_000)).toBe("access-only");
  });

  it("rejects an expired native token instead of refreshing or modifying it", () => {
    const directory = resolve(tmpdir(), `conspectus-kimi-${Date.now()}-${Math.random()}`);
    directories.push(directory);
    mkdirSync(directory, { recursive: true });
    const path = resolve(directory, "kimi-code.json");
    writeFileSync(path, JSON.stringify({ access_token: "expired", expires_at: 1_700_000_000 }));
    expect(() => readKimiAccessToken(path, 1_800_000_000_000)).toThrow("auth_expired");
  });
});
