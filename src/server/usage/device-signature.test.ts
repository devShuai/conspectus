import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { signedMessage } from "./device-signature";

/**
 * The canonical signed message is implemented twice: here and in
 * collector/src/device.ts. Nothing at build time couples them, and a drift
 * would surface only as every report being rejected in production.
 *
 * Both sides pin the same literal, so changing one without the other fails a
 * test instead of shipping.
 */
describe("signedMessage", () => {
  const bodyText = '{"readings":[]}';

  it("is method, path, timestamp, nonce and body hash, one per line", () => {
    const bodyHash = createHash("sha256").update(bodyText).digest("hex");
    expect(
      signedMessage({
        method: "POST",
        path: "/api/collect/usage",
        timestamp: "2026-01-01T00:00:00.000Z",
        nonce: "n-1",
        bodyText,
      }),
    ).toBe(
      `POST\n/api/collect/usage\n2026-01-01T00:00:00.000Z\nn-1\n${bodyHash}`,
    );
  });

  it("keeps fields separated so one cannot be shifted into another", () => {
    // Without per-field separators, moving text across the boundary would
    // produce the same signed bytes for two different requests.
    const a = signedMessage({
      method: "POST",
      path: "/api/collect/usage",
      timestamp: "2026-01-01T00:00:00.000Z",
      nonce: "ab",
      bodyText,
    });
    const b = signedMessage({
      method: "POST",
      path: "/api/collect/usage",
      timestamp: "2026-01-01T00:00:00.000Za",
      nonce: "b",
      bodyText,
    });
    expect(a).not.toBe(b);
  });
});
