import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ReportError,
  flushReportBuffer,
  isRetryableReportError,
  reportLedger,
  reportReadings,
} from "./report.js";
import { enqueueFailedBatch, pendingBatches } from "./buffer.js";
import { saveCliConfig } from "./config.js";
import { setSecretStoreForTests, type SecretStore } from "./keychain.js";
import type { UsageReading } from "./types.js";

/** In-memory SecretStore so tests never touch the real OS keychain. */
class FakeSecretStore implements SecretStore {
  readonly name = "fake";
  readonly map = new Map<string, string>();

  async get(account: string): Promise<string | null> {
    return this.map.get(account) ?? null;
  }

  async set(account: string, secret: string): Promise<void> {
    this.map.set(account, secret);
  }

  async delete(account: string): Promise<void> {
    this.map.delete(account);
  }
}

const CONFIG = {
  serverUrl: "https://c.example.com",
  issuer: "https://auth.example.com",
  cliClientId: "conspectus-cli",
};

let dir: string;
let store: FakeSecretStore;

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

function ledgerDay() {
  return {
    day: "2026-01-01",
    provider: "claude",
    projectKey: "project-1",
    model: "claude-test",
    inputTokens: 1,
    outputTokens: 2,
    cacheReadTokens: 3,
    cacheWriteTokens: 4,
    apiCalls: 1,
    sessions: 1,
    costUsd: 0.01,
  };
}

function httpResponse(status: number, body: unknown = ""): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => (typeof body === "string" ? JSON.parse(body) : body),
  } as Response;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "conspectus-report-"));
  process.env.CONSPECTUS_CONFIG_DIR = dir;
  store = new FakeSecretStore();
  setSecretStoreForTests(store);
  saveCliConfig(CONFIG);
  // logged in (far-future expiry: no refresh) + registered device key
  await store.set(
    "auth-tokens",
    JSON.stringify({
      accessToken: "AT-secret",
      refreshToken: "RT-secret",
      expiresAt: Date.now() + 3_600_000,
    }),
  );
  const { privateKey } = generateKeyPairSync("ed25519");
  await store.set(
    "device-key",
    privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
  );
  writeFileSync(join(dir, "device.json"), JSON.stringify({ deviceId: "dev-1" }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  setSecretStoreForTests(null);
  delete process.env.CONSPECTUS_CONFIG_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe("reportReadings error classification", () => {
  it("network failure is retryable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    const cause = await reportReadings(CONFIG, [reading("b1")]).catch((e: unknown) => e);
    expect(isRetryableReportError(cause)).toBe(true);
  });

  it.each([500, 502, 503, 429])("HTTP %i is retryable", async (status) => {
    vi.stubGlobal("fetch", vi.fn(async () => httpResponse(status, "oops")));
    const cause = await reportReadings(CONFIG, [reading("b1")]).catch((e: unknown) => e);
    expect(cause).toBeInstanceOf(ReportError);
    expect(isRetryableReportError(cause)).toBe(true);
  });

  it.each([400, 401, 403, 422])("HTTP %i is definitive (not retryable)", async (status) => {
    vi.stubGlobal("fetch", vi.fn(async () => httpResponse(status, "bad request")));
    const cause = await reportReadings(CONFIG, [reading("b1")]).catch((e: unknown) => e);
    expect(cause).toBeInstanceOf(ReportError);
    expect(isRetryableReportError(cause)).toBe(false);
  });

  it("keeps the clock-skew guidance for timestamp_out_of_window", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => httpResponse(400, '{"error":"timestamp_out_of_window"}')),
    );
    const cause = await reportReadings(CONFIG, [reading("b1")]).catch((e: unknown) => e);
    expect((cause as Error).message).toContain("校准系统时间");
    expect(isRetryableReportError(cause)).toBe(false);
  });

  it("returns the server result on success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => httpResponse(202, { accepted: 1, rejected: [] })),
    );
    const result = await reportReadings(CONFIG, [reading("b1")]);
    expect(result.accepted).toBe(1);
  });

  it("re-registers once when the server-side device record is missing", async () => {
    const calls: Array<{ url: string; body: string; deviceId?: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, init?: { body?: string; headers?: Record<string, string> }) => {
        calls.push({
          url: String(url),
          body: String(init?.body ?? ""),
          deviceId: init?.headers?.["x-device-id"],
        });
        if (calls.length === 1) {
          return httpResponse(403, { error: "device_not_found" });
        }
        if (String(url).endsWith("/api/collect/devices")) {
          return httpResponse(201, { ok: true, deviceId: "dev-2" });
        }
        return httpResponse(202, { accepted: 1, rejected: [] });
      }),
    );

    const result = await reportReadings(CONFIG, [reading("b1")]);

    expect(result.accepted).toBe(1);
    expect(calls.map((call) => call.url)).toEqual([
      "https://c.example.com/api/collect/usage",
      "https://c.example.com/api/collect/devices",
      "https://c.example.com/api/collect/usage",
    ]);
    expect(JSON.parse(calls[0].body).deviceId).toBe("dev-1");
    expect(JSON.parse(calls[2].body).deviceId).toBe("dev-2");
    expect(calls[0].deviceId).toBe("dev-1");
    expect(calls[2].deviceId).toBe("dev-2");
    expect(store.map.get("device-key")).toBeTruthy();
  });

  it("does not replace a device that the user revoked", async () => {
    const fetchMock = vi.fn(async () => httpResponse(403, { error: "device_revoked" }));
    vi.stubGlobal("fetch", fetchMock);

    const cause = await reportReadings(CONFIG, [reading("b1")]).catch((e: unknown) => e);

    expect(cause).toBeInstanceOf(ReportError);
    expect((cause as Error).message).toContain("device_revoked");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(store.map.has("device-key")).toBe(true);
  });

  it("retries a missing device only once", async () => {
    const fetchMock = vi.fn(async (url: unknown) =>
      String(url).endsWith("/api/collect/devices")
        ? httpResponse(201, { ok: true, deviceId: "dev-2" })
        : httpResponse(403, { error: "device_not_found" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const cause = await reportReadings(CONFIG, [reading("b1")]).catch((e: unknown) => e);

    expect(cause).toBeInstanceOf(ReportError);
    expect(isRetryableReportError(cause)).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("uses the same missing-device recovery for ledger reports", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        urls.push(String(url));
        if (urls.length === 1) return httpResponse(403, { error: "device_not_found" });
        if (String(url).endsWith("/api/collect/devices")) {
          return httpResponse(201, { ok: true, deviceId: "dev-ledger-2" });
        }
        return httpResponse(202, { accepted: 1, rejected: [] });
      }),
    );

    const result = await reportLedger(CONFIG, [ledgerDay()]);

    expect(result.accepted).toBe(1);
    expect(urls).toEqual([
      "https://c.example.com/api/collect/ledger",
      "https://c.example.com/api/collect/devices",
      "https://c.example.com/api/collect/ledger",
    ]);
  });
});

describe("flushReportBuffer", () => {
  it("replays buffered batches oldest-first and clears them", async () => {
    enqueueFailedBatch([reading("first")], "e1");
    enqueueFailedBatch([reading("second")], "e2");
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: { body?: string }) => {
        seen.push(JSON.parse(String(init?.body)).readings[0].bindingId as string);
        return httpResponse(202, { accepted: 1, rejected: [] });
      }),
    );
    const flush = await flushReportBuffer(CONFIG);
    expect(seen).toEqual(["first", "second"]);
    expect(flush).toMatchObject({ flushed: 2, dropped: 0, remaining: 0, retryableFailure: false });
    expect(pendingBatches()).toEqual([]);
  });

  it("stops at the first transient failure and keeps the rest", async () => {
    enqueueFailedBatch([reading("ok")], "e1");
    enqueueFailedBatch([reading("blocked")], "e2");
    enqueueFailedBatch([reading("queued")], "e3");
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++;
        return calls === 1 ? httpResponse(202, { accepted: 1, rejected: [] }) : httpResponse(503);
      }),
    );
    const flush = await flushReportBuffer(CONFIG);
    expect(flush).toMatchObject({ flushed: 1, dropped: 0, remaining: 2, retryableFailure: true });
    expect(pendingBatches().map((b) => b.readings[0].bindingId)).toEqual(["blocked", "queued"]);
  });

  it("drops definitively rejected batches and continues", async () => {
    enqueueFailedBatch([reading("stale")], "e1");
    enqueueFailedBatch([reading("good")], "e2");
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++;
        return calls === 1 ? httpResponse(422, "binding revoked") : httpResponse(202, { accepted: 1, rejected: [] });
      }),
    );
    const flush = await flushReportBuffer(CONFIG);
    expect(flush).toMatchObject({ flushed: 1, dropped: 1, remaining: 0, retryableFailure: false });
    expect(pendingBatches()).toEqual([]);
  });

  it("keeps everything when auth fails before any request", async () => {
    enqueueFailedBatch([reading("b1")], "e1");
    await store.delete("auth-tokens"); // logged out between runs
    const flush = await flushReportBuffer(CONFIG);
    expect(flush).toMatchObject({ flushed: 0, remaining: 1, retryableFailure: true });
    expect(pendingBatches()).toHaveLength(1);
  });
});
