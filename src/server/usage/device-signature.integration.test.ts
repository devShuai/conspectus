import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";

import { describe, expect, it } from "vitest";

import { db } from "@/server/db";
import {
  SIGNATURE_WINDOW_MS,
  verifyDeviceSignature,
} from "./device-signature";

const DISABLED = !process.env.TEST_DATABASE_URL;

const METHOD = "POST";
const PATH = "/api/collect/usage";
const BODY = JSON.stringify({ readings: [] });

function uniqueSub(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function setupDevice() {
  const user = await db.user.create({
    data: {
      certusSub: uniqueSub("dev-sig"),
      certusLinkStatus: "active",
      lastStatusSyncedAt: new Date(),
    },
  });
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const der = publicKey.export({ format: "der", type: "spki" });
  const device = await db.collectorDevice.create({
    data: {
      userId: user.id,
      name: "test",
      platform: "test",
      agentVersion: "0.0.0",
      publicKey: new Uint8Array(der),
      keyAlgorithm: "Ed25519",
    },
  });
  return { user, device, privateKey };
}

function signHeaders(
  privateKey: Parameters<typeof sign>[2],
  deviceId: string,
  opts: { timestamp?: string; nonce?: string; bodyText?: string } = {},
) {
  const timestamp = opts.timestamp ?? new Date().toISOString();
  const nonce = opts.nonce ?? randomUUID();
  const bodyText = opts.bodyText ?? BODY;
  const bodyHash = createHash("sha256").update(bodyText).digest("hex");
  const message = [METHOD, PATH, timestamp, nonce, bodyHash].join("\n");
  return {
    deviceId,
    signature: sign(null, Buffer.from(message, "utf8"), privateKey).toString("base64"),
    timestamp,
    nonce,
  };
}

describe.skipIf(DISABLED)("collector device signature gate (#67)", () => {
  it("accepts a correctly signed report", async () => {
    const { user, device, privateKey } = await setupDevice();
    const result = await verifyDeviceSignature({
      userId: user.id,
      headers: signHeaders(privateKey, device.id),
      method: METHOD,
      path: PATH,
      bodyText: BODY,
    });
    expect(result).toEqual({ ok: true, deviceId: device.id });
  });

  it("rejects a report with no device headers at all", async () => {
    const { user } = await setupDevice();
    // The whole point: omitting the headers must not skip the gate.
    const result = await verifyDeviceSignature({
      userId: user.id,
      headers: { deviceId: null, signature: null, timestamp: null, nonce: null },
      method: METHOD,
      path: PATH,
      bodyText: BODY,
    });
    expect(result).toEqual({ ok: false, reason: "device_signature_required" });
  });

  it("rejects when any single header is missing", async () => {
    const { user, device, privateKey } = await setupDevice();
    const full = signHeaders(privateKey, device.id);
    for (const key of ["deviceId", "signature", "timestamp", "nonce"] as const) {
      const result = await verifyDeviceSignature({
        userId: user.id,
        headers: { ...full, [key]: null },
        method: METHOD,
        path: PATH,
        bodyText: BODY,
      });
      expect(result).toEqual({ ok: false, reason: "device_signature_required" });
    }
  });

  it("rejects a revoked device even with a valid signature", async () => {
    const { user, device, privateKey } = await setupDevice();
    await db.collectorDevice.update({
      where: { id: device.id },
      data: { revokedAt: new Date() },
    });
    const result = await verifyDeviceSignature({
      userId: user.id,
      headers: signHeaders(privateKey, device.id),
      method: METHOD,
      path: PATH,
      bodyText: BODY,
    });
    expect(result).toEqual({ ok: false, reason: "device_revoked" });
  });

  it("rejects another user's device", async () => {
    const a = await setupDevice();
    const b = await setupDevice();
    const result = await verifyDeviceSignature({
      userId: b.user.id,
      headers: signHeaders(a.privateKey, a.device.id),
      method: METHOD,
      path: PATH,
      bodyText: BODY,
    });
    expect(result).toEqual({ ok: false, reason: "device_not_found" });
  });

  it("rejects a replayed nonce", async () => {
    const { user, device, privateKey } = await setupDevice();
    const headers = signHeaders(privateKey, device.id);
    const first = await verifyDeviceSignature({
      userId: user.id,
      headers,
      method: METHOD,
      path: PATH,
      bodyText: BODY,
    });
    expect(first.ok).toBe(true);

    const replay = await verifyDeviceSignature({
      userId: user.id,
      headers,
      method: METHOD,
      path: PATH,
      bodyText: BODY,
    });
    expect(replay).toEqual({ ok: false, reason: "replayed_nonce" });
  });

  it("rejects a timestamp outside the window with a distinct code", async () => {
    const { user, device, privateKey } = await setupDevice();
    const stale = new Date(Date.now() - SIGNATURE_WINDOW_MS - 60_000).toISOString();
    const result = await verifyDeviceSignature({
      userId: user.id,
      headers: signHeaders(privateKey, device.id, { timestamp: stale }),
      method: METHOD,
      path: PATH,
      bodyText: BODY,
    });
    // distinct so the CLI can tell the user to fix their clock
    expect(result).toEqual({ ok: false, reason: "timestamp_out_of_window" });
  });

  it("rejects a tampered body", async () => {
    const { user, device, privateKey } = await setupDevice();
    const headers = signHeaders(privateKey, device.id, { bodyText: BODY });
    const result = await verifyDeviceSignature({
      userId: user.id,
      headers,
      method: METHOD,
      path: PATH,
      bodyText: JSON.stringify({ readings: [{ tampered: true }] }),
    });
    expect(result).toEqual({ ok: false, reason: "invalid_signature" });
  });

  it("rejects a signature made with a different key", async () => {
    const { user, device } = await setupDevice();
    const other = generateKeyPairSync("ed25519");
    const result = await verifyDeviceSignature({
      userId: user.id,
      headers: signHeaders(other.privateKey, device.id),
      method: METHOD,
      path: PATH,
      bodyText: BODY,
    });
    expect(result).toEqual({ ok: false, reason: "invalid_signature" });
  });
});
