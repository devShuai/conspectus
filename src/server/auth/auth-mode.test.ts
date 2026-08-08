import { describe, expect, it } from "vitest";

import {
  authModeGate,
  certusAuthEnabled,
  currentAuthMode,
  localAuthEnabled,
} from "./auth-mode";

describe("auth mode (#97)", () => {
  it("defaults to certus and validates the value", () => {
    expect(currentAuthMode({})).toBe("certus");
    expect(currentAuthMode({ AUTH_MODE: "local" })).toBe("local");
    expect(currentAuthMode({ AUTH_MODE: " both " })).toBe("both");
    expect(() => currentAuthMode({ AUTH_MODE: "oidc" })).toThrow(/AUTH_MODE/);
  });

  it("feature flags follow the mode", () => {
    expect(localAuthEnabled("certus")).toBe(false);
    expect(localAuthEnabled("local")).toBe(true);
    expect(localAuthEnabled("both")).toBe(true);
    expect(certusAuthEnabled("certus")).toBe(true);
    expect(certusAuthEnabled("local")).toBe(false);
    expect(certusAuthEnabled("both")).toBe(true);
  });

  it("gate returns 404 only when the feature is disabled", async () => {
    expect(authModeGate("local", { AUTH_MODE: "local" })).toBeNull();
    expect(authModeGate("local", { AUTH_MODE: "both" })).toBeNull();
    expect(authModeGate("certus", { AUTH_MODE: "certus" })).toBeNull();
    expect(authModeGate("certus", { AUTH_MODE: "both" })).toBeNull();

    const localOff = authModeGate("local", { AUTH_MODE: "certus" });
    expect(localOff?.status).toBe(404);
    expect(await localOff?.json()).toEqual({ error: "not_found" });
    const certusOff = authModeGate("certus", { AUTH_MODE: "local" });
    expect(certusOff?.status).toBe(404);
  });
});
