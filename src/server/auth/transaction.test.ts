import { describe, expect, it, vi } from "vitest";

import {
  createOIDCTransaction,
  OIDC_TRANSACTION_TTL_MS,
  peekOIDCTransaction,
  readOIDCTransaction,
} from "./transaction";

const SECRET = "test-auth-secret-with-at-least-32-bytes";
const OTHER_SECRET = "different-test-secret-with-at-least-32-bytes";

const input = {
  state: "state-value",
  nonce: "nonce-value",
  codeVerifier: "pkce-code-verifier",
} as const;

describe("signed OIDC transaction cookie", () => {
  it("survives a fresh module instance without process-shared storage", async () => {
    const { handle, transaction } = createOIDCTransaction(input, SECRET, 10_000);

    vi.resetModules();
    const freshModule = await import("./transaction");
    expect(freshModule.readOIDCTransaction(handle, SECRET, 10_001)).toEqual(transaction);
  });

  it("contains only the required compact signed fields", () => {
    const { handle } = createOIDCTransaction(input, SECRET, 10_000);
    const [version, encodedPayload, encodedSignature] = handle.split(".");
    const payload = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8"),
    );

    expect(version).toBe("v1");
    expect(Object.keys(payload).sort()).toEqual(["c", "e", "n", "p", "s"]);
    expect(encodedSignature).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(handle.length).toBeLessThan(4_096);
  });

  it("rejects payload tampering, a different secret and malformed cookies", () => {
    const { handle } = createOIDCTransaction(input, SECRET, 10_000);
    const [version, encodedPayload, encodedSignature] = handle.split(".");
    const payload = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8"),
    );
    payload.p = "bind";
    payload.u = "attacker-user";
    const tamperedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString(
      "base64url",
    );

    expect(
      readOIDCTransaction(
        `${version}.${tamperedPayload}.${encodedSignature}`,
        SECRET,
        10_001,
      ),
    ).toBeNull();
    expect(readOIDCTransaction(handle, OTHER_SECRET, 10_001)).toBeNull();
    expect(
      readOIDCTransaction("v1.not-base64!.signature", SECRET, 10_001),
    ).toBeNull();
    expect(readOIDCTransaction(undefined, SECRET, 10_001)).toBeNull();
  });

  it("rejects the cookie at the exact expiry boundary", () => {
    const { handle } = createOIDCTransaction(input, SECRET, 10_000);
    expect(
      peekOIDCTransaction(
        handle,
        SECRET,
        10_000 + OIDC_TRANSACTION_TTL_MS - 1,
      ),
    ).not.toBeNull();
    expect(
      peekOIDCTransaction(handle, SECRET, 10_000 + OIDC_TRANSACTION_TTL_MS),
    ).toBeNull();
  });

  it("protects bind purpose and user identity with the signature", () => {
    const { handle } = createOIDCTransaction(
      { ...input, purpose: "bind", bindUserId: "user-id" },
      SECRET,
      10_000,
    );
    expect(readOIDCTransaction(handle, SECRET, 10_001)).toMatchObject({
      purpose: "bind",
      bindUserId: "user-id",
    });
  });
});
