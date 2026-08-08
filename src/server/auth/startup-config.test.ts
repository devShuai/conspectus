import { describe, expect, it } from "vitest";

import { loadStartupConfig } from "./startup-config";

const base = {
  NODE_ENV: "test",
  APP_URL: "http://127.0.0.1:3000",
  CERTUS_ISSUER: "http://127.0.0.1:8080",
  CERTUS_CLIENT_ID: "conspectus",
  CERTUS_CLIENT_SECRET: "test-secret",
  AUTH_SECRET: "test-auth-secret-with-at-least-32-bytes",
  AUTH_MODE: "certus",
  CRON_SECRET: "cron-secret-value",
  DEPLOY_PROBE_SECRET: "probe-secret-value",
  CREDENTIAL_ENC_KEYS: `v1:${Buffer.alloc(32, 3).toString("base64")}`,
  ACTIVE_CREDENTIAL_KEY_ID: "v1",
};

describe("loadStartupConfig", () => {
  it("accepts a valid certus-only configuration", () => {
    const config = loadStartupConfig(base);
    expect(config.authMode).toBe("certus");
    expect(config.cronSecret).toBe("cron-secret-value");
    expect(config.deployProbeSecret).toBe("probe-secret-value");
    expect(config.identityStatusTtlMs).toBe(60 * 60 * 1000);
  });

  it.each([
    ["local mode", { ...base, AUTH_MODE: "local" }],
    ["both mode", { ...base, AUTH_MODE: "both" }],
    ["missing cron secret", { ...base, CRON_SECRET: "" }],
    ["placeholder cron secret", { ...base, CRON_SECRET: "change-me" }],
    ["missing probe secret", { ...base, DEPLOY_PROBE_SECRET: "" }],
    ["probe equals cron", { ...base, DEPLOY_PROBE_SECRET: "cron-secret-value" }],
    ["ttl >= max stale", { ...base, IDENTITY_STATUS_TTL: "2d", IDENTITY_STATUS_MAX_STALE: "1d" }],
    ["test database url in production (#64)", { ...base, NODE_ENV: "production", TEST_DATABASE_URL: "postgres://test/db" }],
  ])("rejects %s", (_name, environment) => {
    expect(() => loadStartupConfig(environment)).toThrow();
  });

  it("accepts TEST_DATABASE_URL outside production (#64)", () => {
    const config = loadStartupConfig({
      ...base,
      TEST_DATABASE_URL: "postgres://test/db",
    });
    expect(config.authMode).toBe("certus");
  });

  it("parses duration strings", () => {
    const config = loadStartupConfig({
      ...base,
      IDENTITY_STATUS_TTL: "30m",
      IDENTITY_STATUS_MAX_STALE: "36h",
    });
    expect(config.identityStatusTtlMs).toBe(30 * 60 * 1000);
    expect(config.identityStatusMaxStaleMs).toBe(36 * 3600 * 1000);
  });
});
