import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FileSecretStore, setSecretStoreForTests, type SecretStore } from "./keychain.js";
import { clearTokens, loadTokens, storeTokens } from "./config.js";
import { ensureDevice } from "./device.js";
import type { StoredToken } from "./types.js";

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

let dir: string;
let store: FakeSecretStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "conspectus-test-"));
  process.env.CONSPECTUS_CONFIG_DIR = dir;
  store = new FakeSecretStore();
  setSecretStoreForTests(store);
});

afterEach(() => {
  setSecretStoreForTests(null);
  delete process.env.CONSPECTUS_CONFIG_DIR;
  rmSync(dir, { recursive: true, force: true });
});

const TOKENS: StoredToken = {
  accessToken: "AT-secret",
  refreshToken: "RT-secret",
  expiresAt: Date.now() + 3_600_000,
};

describe("FileSecretStore", () => {
  it("round-trips secrets in a 0600 file inside the config dir", async () => {
    const file = new FileSecretStore();
    await file.set("a", "s3cret");
    expect(await file.get("a")).toBe("s3cret");
    expect(existsSync(join(dir, "secrets.json"))).toBe(true);
    const mode = (await import("node:fs")).statSync(join(dir, "secrets.json")).mode & 0o777;
    if (process.platform !== "win32") expect(mode).toBe(0o600);
    await file.delete("a");
    expect(await file.get("a")).toBeNull();
  });
});

describe("token storage (keychain)", () => {
  it("stores tokens in the secret store, not on disk", async () => {
    await storeTokens(TOKENS);
    expect(store.map.get("auth-tokens")).toBe(JSON.stringify(TOKENS));
    expect(existsSync(join(dir, "tokens.json"))).toBe(false);
    expect(await loadTokens()).toEqual(TOKENS);
  });

  it("migrates a legacy plaintext tokens.json into the store and deletes it", async () => {
    writeFileSync(join(dir, "tokens.json"), JSON.stringify(TOKENS), { mode: 0o600 });
    const loaded = await loadTokens();
    expect(loaded).toEqual(TOKENS);
    expect(store.map.get("auth-tokens")).toBe(JSON.stringify(TOKENS));
    expect(existsSync(join(dir, "tokens.json"))).toBe(false);
    // subsequent store must not resurrect the file
    await storeTokens(TOKENS);
    expect(existsSync(join(dir, "tokens.json"))).toBe(false);
  });

  it("clearTokens removes both the store entry and any legacy file", async () => {
    await storeTokens(TOKENS);
    writeFileSync(join(dir, "tokens.json"), JSON.stringify(TOKENS));
    await clearTokens();
    expect(store.map.has("auth-tokens")).toBe(false);
    expect(existsSync(join(dir, "tokens.json"))).toBe(false);
    expect(await loadTokens()).toBeNull();
  });
});

describe("device key storage (keychain)", () => {
  it("keeps only deviceId on disk; the private key goes to the store", async () => {
    const fetchMock = vi.fn(async (url: unknown) => {
      expect(String(url)).toContain("/api/collect/devices");
      return {
        ok: true,
        status: 200,
        json: async () => ({ deviceId: "dev-1" }),
        text: async () => "",
      } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);
    await storeTokens(TOKENS);
    const device = await ensureDevice({
      serverUrl: "https://c.example.com",
      issuer: "https://auth.example.com",
      cliClientId: "conspectus-cli",
    });
    vi.unstubAllGlobals();

    expect(device.deviceId).toBe("dev-1");
    expect(store.map.get("device-key")).toBe(device.privateKey);
    const onDisk = JSON.parse(readFileSync(join(dir, "device.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(onDisk).toEqual({ deviceId: "dev-1" }); // no privateKey on disk

    // second load reads from store, no re-registration
    const again = await ensureDevice({
      serverUrl: "https://c.example.com",
      issuer: "https://auth.example.com",
      cliClientId: "conspectus-cli",
    });
    expect(again).toEqual(device);
  });

  it("migrates a legacy device.json with embedded privateKey into the store", async () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const legacy = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
    writeFileSync(
      join(dir, "device.json"),
      JSON.stringify({ deviceId: "dev-legacy", privateKey: legacy }),
      { mode: 0o600 },
    );
    await storeTokens(TOKENS); // validAccessToken must not hit the network
    const device = await ensureDevice({
      serverUrl: "https://c.example.com",
      issuer: "https://auth.example.com",
      cliClientId: "conspectus-cli",
    });
    expect(device).toEqual({ deviceId: "dev-legacy", privateKey: legacy });
    expect(store.map.get("device-key")).toBe(legacy);
    const onDisk = JSON.parse(readFileSync(join(dir, "device.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(onDisk).toEqual({ deviceId: "dev-legacy" });
  });
});
