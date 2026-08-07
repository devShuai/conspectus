import { describe, expect, it } from "vitest";

import {
  evaluateDeviceM0Result,
  fingerprint,
  summarizeIntrospection,
} from "./device-introspection.js";

describe("summarizeIntrospection", () => {
  it("marks active tokens with usage:write and fingerprints subject", () => {
    const evidence = summarizeIntrospection({
      active: true,
      client_id: "conspectus-cli",
      scope: "openid usage:write",
      sub: "user-sub-value",
      token_type: "Bearer",
    });

    expect(evidence.active).toBe(true);
    expect(evidence.clientId).toBe("conspectus-cli");
    expect(evidence.hasUsageWrite).toBe(true);
    expect(evidence.subjectFingerprint).toBe(fingerprint("user-sub-value"));
    expect(evidence.inactiveWithoutLeak).toBe(false);
  });

  it("treats bare active:false as non-leaking denial", () => {
    const evidence = summarizeIntrospection({ active: false });
    expect(evidence.active).toBe(false);
    expect(evidence.inactiveWithoutLeak).toBe(true);
    expect(evidence.subjectFingerprint).toBeUndefined();
    expect(evidence.clientId).toBeUndefined();
  });
});

describe("evaluateDeviceM0Result", () => {
  it("goes when token and allowed introspection match expectations", () => {
    const result = evaluateDeviceM0Result({
      token: {
        accessTokenPresent: true,
        accessTokenFingerprint: "abc",
        scope: ["openid", "usage:write"],
        hasUsageWrite: true,
      },
      allowedIntrospection: {
        active: true,
        clientId: "conspectus-cli",
        scope: ["openid", "usage:write"],
        hasUsageWrite: true,
        subjectFingerprint: "subfp",
        inactiveWithoutLeak: false,
      },
      deniedIntrospection: {
        active: false,
        scope: [],
        hasUsageWrite: false,
        inactiveWithoutLeak: true,
      },
      expectedTokenClientId: "conspectus-cli",
      resourceClientId: "conspectus",
    });

    expect(result.go).toBe(true);
    expect(result.checks.every((check) => check.ok)).toBe(true);
  });

  it("fails when whitelist is missing and introspection stays inactive", () => {
    const result = evaluateDeviceM0Result({
      token: {
        accessTokenPresent: true,
        accessTokenFingerprint: "abc",
        scope: ["openid", "usage:write"],
        hasUsageWrite: true,
      },
      allowedIntrospection: {
        active: false,
        scope: [],
        hasUsageWrite: false,
        inactiveWithoutLeak: true,
      },
      expectedTokenClientId: "conspectus-cli",
      resourceClientId: "conspectus",
    });

    expect(result.go).toBe(false);
    expect(result.checks.find((check) => check.id === "introspect_active")?.ok).toBe(
      false,
    );
  });

  it("fails when access token lacks usage:write", () => {
    const result = evaluateDeviceM0Result({
      token: {
        accessTokenPresent: true,
        accessTokenFingerprint: "abc",
        scope: ["openid"],
        hasUsageWrite: false,
      },
      allowedIntrospection: {
        active: true,
        clientId: "conspectus-cli",
        scope: ["openid"],
        hasUsageWrite: false,
        subjectFingerprint: "subfp",
        inactiveWithoutLeak: false,
      },
      expectedTokenClientId: "conspectus-cli",
      resourceClientId: "conspectus",
    });

    expect(result.go).toBe(false);
    expect(
      result.checks.find((check) => check.id === "token_scope_usage_write")?.ok,
    ).toBe(false);
  });
});
