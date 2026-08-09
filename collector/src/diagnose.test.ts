import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runDiagnose } from "./diagnose.js";
import { saveCliConfig } from "./config.js";
import { enqueueFailedBatch } from "./buffer.js";
import { setSecretStoreForTests, type SecretStore } from "./keychain.js";
import { persistState } from "./collectors/runner.js";

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

const ACCESS = "AT-should-never-appear";
const REFRESH = "RT-should-never-appear";
const DEVICE_KEY = "PK-should-never-appear";

let dir: string;
let store: FakeSecretStore;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "conspectus-diagnose-"));
  process.env.CONSPECTUS_CONFIG_DIR = dir;
  store = new FakeSecretStore();
  setSecretStoreForTests(store);
  saveCliConfig({
    serverUrl: "https://c.example.com",
    issuer: "https://auth.example.com",
    cliClientId: "conspectus-cli",
  });
  await store.set(
    "auth-tokens",
    JSON.stringify({ accessToken: ACCESS, refreshToken: REFRESH, expiresAt: Date.now() + 3_600_000 }),
  );
  await store.set("device-key", DEVICE_KEY);
  writeFileSync(join(dir, "device.json"), JSON.stringify({ deviceId: "dev-1" }));
  enqueueFailedBatch(
    [
      {
        bindingId: "b1",
        kind: "quota",
        metric: "requests",
        unit: "req",
        usedValue: "1",
        capturedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    "report failed: 503",
  );
  persistState([
    { id: "codex", ok: false, error: "boom", readings: 0, lastErrorAt: "2026-01-01T00:00:00.000Z" },
  ]);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ status: 401, ok: false }) as Response),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  setSecretStoreForTests(null);
  delete process.env.CONSPECTUS_CONFIG_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe("runDiagnose", () => {
  it("reports config, keychain, token presence, device, connectivity, buffer and collectors", async () => {
    const report = await runDiagnose();
    expect(report.config.exists).toBe(true);
    expect(report.config.serverUrl).toBe("https://c.example.com");
    expect(report.keychain.backend).toBe("fake");
    expect(report.tokens).toMatchObject({
      present: true,
      hasAccessToken: true,
      hasRefreshToken: true,
      expired: false,
    });
    expect(report.device).toEqual({ registered: true, deviceId: "dev-1", keyPresent: true });
    expect(report.connectivity.server).toEqual({ reachable: true, status: 401 });
    expect(report.connectivity.issuer).toEqual({ reachable: true, status: 401 });
    expect(report.buffer.batches).toBe(1);
    expect(report.buffer.readings).toBe(1);
    expect(report.buffer.lastError).toContain("503");
    expect(report.collectors.codex.lastErrorAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("never leaks token or key material into the output", async () => {
    const serialized = JSON.stringify(await runDiagnose());
    expect(serialized).not.toContain(ACCESS);
    expect(serialized).not.toContain(REFRESH);
    expect(serialized).not.toContain(DEVICE_KEY);
  });

  it("survives a missing config and an unreachable server", async () => {
    rmSync(join(dir, "config.json"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    const report = await runDiagnose();
    expect(report.config.exists).toBe(false);
    expect(report.connectivity.server).toBeUndefined();
    expect(report.tokens.present).toBe(true);
  });
});
