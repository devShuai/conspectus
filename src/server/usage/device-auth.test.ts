import { afterEach, describe, expect, it, vi } from "vitest";

import { introspectCliToken } from "./device-auth";

/**
 * Introspection must satisfy all three conditions from design §7.4:
 * active=true, client_id=conspectus-cli, and scope containing usage:write.
 * Each is tested failing on its own so a future refactor cannot drop one
 * silently.
 */

function mockIntrospection(body: Record<string, unknown>, ok = true): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok,
      json: async () => body,
    } as unknown as Response),
  );
}

function bearer(): string {
  // unique per call so the module-level 45s cache never leaks between cases
  return `Bearer tok-${Math.random().toString(36).slice(2)}`;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("introspectCliToken", () => {
  it("returns the sub when all three conditions hold", async () => {
    mockIntrospection({
      active: true,
      sub: "user-1",
      client_id: "conspectus-cli",
      scope: "openid profile usage:write",
    });
    await expect(introspectCliToken(bearer())).resolves.toBe("user-1");
  });

  it("rejects a non-Bearer authorization header", async () => {
    mockIntrospection({ active: true, sub: "u", client_id: "conspectus-cli", scope: "usage:write" });
    await expect(introspectCliToken("Basic abc")).resolves.toBeNull();
    await expect(introspectCliToken(null)).resolves.toBeNull();
  });

  it("rejects active=false", async () => {
    mockIntrospection({
      active: false,
      sub: "user-1",
      client_id: "conspectus-cli",
      scope: "usage:write",
    });
    await expect(introspectCliToken(bearer())).resolves.toBeNull();
  });

  it("rejects a token issued to another client", async () => {
    mockIntrospection({
      active: true,
      sub: "user-1",
      client_id: "conspectus",
      scope: "usage:write",
    });
    await expect(introspectCliToken(bearer())).resolves.toBeNull();
  });

  it("rejects a token without usage:write", async () => {
    mockIntrospection({
      active: true,
      sub: "user-1",
      client_id: "conspectus-cli",
      scope: "openid profile",
    });
    await expect(introspectCliToken(bearer())).resolves.toBeNull();
  });

  it("rejects a missing sub", async () => {
    mockIntrospection({
      active: true,
      client_id: "conspectus-cli",
      scope: "usage:write",
    });
    await expect(introspectCliToken(bearer())).resolves.toBeNull();
  });

  it("rejects a non-ok introspection response", async () => {
    mockIntrospection({}, false);
    await expect(introspectCliToken(bearer())).resolves.toBeNull();
  });
});
