import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ensureKimiAccessToken, parseKimiUsage, readKimiAccessToken } from "./kimi.js";

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

  it("ignores malformed limit rows instead of throwing a native TypeError", () => {
    const readings = parseKimiUsage(
      {
        usage: { used: 1, limit: 20 },
        limits: [null, "bad", { window: null }],
      },
      BINDINGS,
      "2026-08-10T10:00:00Z",
    );
    expect(readings.map((reading) => reading.metric)).toEqual(["kimi:weekly"]);
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

  it("refreshes an expired native token and atomically persists the rotated bundle", async () => {
    const directory = resolve(tmpdir(), `conspectus-kimi-${Date.now()}-${Math.random()}`);
    directories.push(directory);
    mkdirSync(directory, { recursive: true });
    const path = resolve(directory, "kimi-code.json");
    writeFileSync(
      path,
      JSON.stringify({
        access_token: "expired-access",
        refresh_token: "old-refresh",
        expires_at: 1_700_000_000,
        expires_in: 3600,
        account_hint: "preserve-me",
      }),
    );
    let requestBody = "";
    const token = await ensureKimiAccessToken(path, 1_800_000_000_000, {
      fetchImpl: async (_input, init) => {
        requestBody = String(init?.body);
        return new Response(
          JSON.stringify({
            access_token: "fresh-access",
            refresh_token: "rotated-refresh",
            expires_in: 3600,
            scope: "openid",
            token_type: "Bearer",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    expect(token).toBe("fresh-access");
    const stored = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(stored).toMatchObject({
      access_token: "fresh-access",
      refresh_token: "rotated-refresh",
      expires_at: 1_800_003_600,
      account_hint: "preserve-me",
    });
    expect(requestBody).toContain("grant_type=refresh_token");
    expect(requestBody).toContain("refresh_token=old-refresh");
  });

  it("recovers when Kimi Code rotates the refresh token concurrently", async () => {
    const directory = resolve(tmpdir(), `conspectus-kimi-${Date.now()}-${Math.random()}`);
    directories.push(directory);
    mkdirSync(directory, { recursive: true });
    const path = resolve(directory, "kimi-code.json");
    const now = Date.now();
    writeFileSync(
      path,
      JSON.stringify({
        access_token: "expired-access",
        refresh_token: "stale-refresh",
        expires_at: Math.floor(now / 1000) - 1,
        expires_in: 3600,
      }),
    );

    const token = await ensureKimiAccessToken(path, now, {
      sleep: async () => {},
      fetchImpl: async () => {
        writeFileSync(
          path,
          JSON.stringify({
            access_token: "peer-access",
            refresh_token: "peer-rotated-refresh",
            expires_at: Math.floor(now / 1000) + 3600,
            expires_in: 3600,
          }),
        );
        return new Response(JSON.stringify({ error: "invalid_grant" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      },
    });

    expect(token).toBe("peer-access");
  });

  it("does not refresh twice when two collector runs race", async () => {
    const directory = resolve(tmpdir(), `conspectus-kimi-${Date.now()}-${Math.random()}`);
    directories.push(directory);
    mkdirSync(directory, { recursive: true });
    const path = resolve(directory, "kimi-code.json");
    const now = Date.now();
    writeFileSync(
      path,
      JSON.stringify({
        access_token: "expired-access",
        refresh_token: "old-refresh",
        expires_at: Math.floor(now / 1000) - 1,
        expires_in: 3600,
      }),
    );
    let refreshes = 0;
    const fetchImpl: typeof fetch = async () => {
      refreshes += 1;
      return new Response(
        JSON.stringify({
          access_token: "shared-access",
          refresh_token: "shared-refresh",
          expires_in: 3600,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const tokens = await Promise.all([
      ensureKimiAccessToken(path, now, { fetchImpl }),
      ensureKimiAccessToken(path, now, { fetchImpl }),
    ]);

    expect(tokens).toEqual(["shared-access", "shared-access"]);
    expect(refreshes).toBe(1);
  });
});
