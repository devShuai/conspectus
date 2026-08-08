import { describe, expect, it } from "vitest";

import { loadDeviceM0Config } from "./device-m0-config";

const base = {
  NODE_ENV: "test",
  APP_URL: "http://127.0.0.1:3000",
  CERTUS_ISSUER: "https://certus.example.com",
  CERTUS_CLIENT_ID: "conspectus",
  CERTUS_CLIENT_SECRET: "resource-secret",
  AUTH_SECRET: "test-auth-secret-with-at-least-32-bytes",
  CERTUS_CLI_CLIENT_ID: "conspectus-cli",
};

describe("loadDeviceM0Config", () => {
  it("defaults resource client to CERTUS_CLIENT_* and scope to usage:write set", () => {
    const config = loadDeviceM0Config(base);
    expect(config.cliClientId).toBe("conspectus-cli");
    expect(config.resourceClientId).toBe("conspectus");
    expect(config.resourceClientSecret).toBe("resource-secret");
    expect(config.deviceScope).toBe("openid profile usage:write");
    expect(config.expectedTokenClientId).toBe("conspectus-cli");
  });

  it("rejects missing CLI client id", () => {
    expect(() =>
      loadDeviceM0Config({ ...base, CERTUS_CLI_CLIENT_ID: "" }),
    ).toThrow(/CERTUS_CLI_CLIENT_ID/);
  });
});
