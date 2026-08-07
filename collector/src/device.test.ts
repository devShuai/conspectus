import { createHash, createPublicKey, generateKeyPairSync, verify } from "node:crypto";

import { describe, expect, it } from "vitest";

import { signRequest } from "./device.js";

/**
 * The CLI and the server implement the signed message separately (here and in
 * src/server/usage/device-signature.ts). These tests pin the wire format from
 * the client side so the two cannot drift apart silently — a mismatch would
 * show up only as every report being rejected in production.
 */

function makeDevice() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    device: {
      deviceId: "11111111-1111-1111-1111-111111111111",
      privateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
    },
    publicKeyDer: publicKey.export({ format: "der", type: "spki" }),
  };
}

/** Independent re-implementation of the server's canonical message. */
function expectedMessage(
  method: string,
  path: string,
  timestamp: string,
  nonce: string,
  bodyText: string,
): string {
  const bodyHash = createHash("sha256").update(bodyText).digest("hex");
  return [method, path, timestamp, nonce, bodyHash].join("\n");
}

describe("canonical message format", () => {
  it("matches the literal pinned on the server side", () => {
    // Mirrors src/server/usage/device-signature.test.ts. If either side
    // changes the format without the other, one of the two fails.
    const bodyText = '{"readings":[]}';
    const bodyHash = createHash("sha256").update(bodyText).digest("hex");
    expect(
      expectedMessage("POST", "/api/collect/usage", "2026-01-01T00:00:00.000Z", "n-1", bodyText),
    ).toBe(`POST
/api/collect/usage
2026-01-01T00:00:00.000Z
n-1
${bodyHash}`);
  });
});

describe("signRequest", () => {
  const input = {
    method: "POST",
    path: "/api/collect/usage",
    bodyText: JSON.stringify({ readings: [] }),
  };

  it("produces a signature the server's public key can verify", () => {
    const { device, publicKeyDer } = makeDevice();
    const headers = signRequest(device, input);

    const message = expectedMessage(
      input.method,
      input.path,
      headers["x-device-timestamp"],
      headers["x-device-nonce"],
      input.bodyText,
    );
    const ok = verify(
      null,
      Buffer.from(message, "utf8"),
      createPublicKey({ key: publicKeyDer, format: "der", type: "spki" }),
      Buffer.from(headers["x-device-signature"], "base64"),
    );
    expect(ok).toBe(true);
  });

  it("sends all four headers the server requires", () => {
    const { device } = makeDevice();
    const headers = signRequest(device, input);
    expect(Object.keys(headers).sort()).toEqual([
      "x-device-id",
      "x-device-nonce",
      "x-device-signature",
      "x-device-timestamp",
    ]);
    expect(headers["x-device-id"]).toBe(device.deviceId);
    expect(headers["x-device-timestamp"]).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
  });

  it("uses a fresh nonce per request so a replay cannot be produced by resigning", () => {
    const { device } = makeDevice();
    const a = signRequest(device, input);
    const b = signRequest(device, input);
    expect(a["x-device-nonce"]).not.toBe(b["x-device-nonce"]);
    expect(a["x-device-signature"]).not.toBe(b["x-device-signature"]);
  });

  it("binds the signature to the body", () => {
    const { device, publicKeyDer } = makeDevice();
    const headers = signRequest(device, input);

    // same headers, different body -> verification must fail
    const tampered = expectedMessage(
      input.method,
      input.path,
      headers["x-device-timestamp"],
      headers["x-device-nonce"],
      JSON.stringify({ readings: [{ tampered: true }] }),
    );
    const ok = verify(
      null,
      Buffer.from(tampered, "utf8"),
      createPublicKey({ key: publicKeyDer, format: "der", type: "spki" }),
      Buffer.from(headers["x-device-signature"], "base64"),
    );
    expect(ok).toBe(false);
  });

  it("binds the signature to method and path", () => {
    const { device, publicKeyDer } = makeDevice();
    const headers = signRequest(device, input);
    const pub = createPublicKey({ key: publicKeyDer, format: "der", type: "spki" });
    const sig = Buffer.from(headers["x-device-signature"], "base64");

    for (const wrong of [
      expectedMessage("GET", input.path, headers["x-device-timestamp"], headers["x-device-nonce"], input.bodyText),
      expectedMessage(input.method, "/api/collect/devices", headers["x-device-timestamp"], headers["x-device-nonce"], input.bodyText),
    ]) {
      expect(verify(null, Buffer.from(wrong, "utf8"), pub, sig)).toBe(false);
    }
  });
});
