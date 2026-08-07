import { describe, expect, it, vi } from "vitest";

import { logoutReplayExpiry } from "./logout-token.js";

describe("logout replay expiry", () => {
  it("extends token exp by grace", () => {
    const now = new Date(1_700_000_000_000);
    const exp = Math.floor(now.getTime() / 1000) + 120;
    const expiry = logoutReplayExpiry(exp, now);
    expect(expiry.getTime()).toBe(exp * 1000 + 10 * 60 * 1000);
  });

  it("uses now + default window when exp missing", () => {
    const now = new Date(1_700_000_000_000);
    const expiry = logoutReplayExpiry(undefined, now);
    expect(expiry.getTime()).toBe(now.getTime() + 2 * 60 * 1000 + 10 * 60 * 1000);
  });
});

// validateLogoutToken is covered indirectly by integration route tests;
// unit-level JWT verification requires a live JWKS — skipped here.
void vi;
