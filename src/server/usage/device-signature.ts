import { createHash, createPublicKey, verify } from "node:crypto";

import { db } from "@/server/db";

/** Clock skew tolerated on the report timestamp (design §6.2). */
export const SIGNATURE_WINDOW_MS = 5 * 60 * 1000;

export type DeviceGateFailure =
  | "device_signature_required"
  | "device_not_found"
  | "device_revoked"
  | "timestamp_out_of_window"
  | "invalid_signature"
  | "replayed_nonce";

export type DeviceGateResult =
  | { ok: true; deviceId: string }
  | { ok: false; reason: DeviceGateFailure };

export interface DeviceSignatureHeaders {
  deviceId: string | null;
  signature: string | null;
  timestamp: string | null;
  nonce: string | null;
}

/**
 * Canonical signed message: method + path + timestamp + nonce + bodyHash
 * (design §6.2). Each component is on its own line so no field can be shifted
 * into another by crafting separators.
 */
export function signedMessage(input: {
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  bodyText: string;
}): string {
  const bodyHash = createHash("sha256").update(input.bodyText).digest("hex");
  return [input.method, input.path, input.timestamp, input.nonce, bodyHash].join("\n");
}

/**
 * Mandatory device gate for collector reports.
 *
 * The signature proves the request comes from a registered, non-revoked
 * device. It must never be optional: making it conditional on the headers
 * being present lets any holder of a stolen CLI token skip it entirely, and
 * also defeats single-device revocation (design §7.4).
 */
export async function verifyDeviceSignature(input: {
  userId: string;
  headers: DeviceSignatureHeaders;
  method: string;
  path: string;
  bodyText: string;
  now?: Date;
}): Promise<DeviceGateResult> {
  const { deviceId, signature, timestamp, nonce } = input.headers;
  if (!deviceId || !signature || !timestamp || !nonce) {
    return { ok: false, reason: "device_signature_required" };
  }

  const device = await db.collectorDevice.findFirst({
    where: { id: deviceId, userId: input.userId },
  });
  if (!device) return { ok: false, reason: "device_not_found" };
  if (device.revokedAt) return { ok: false, reason: "device_revoked" };

  const now = input.now ?? new Date();
  const ts = new Date(timestamp).getTime();
  if (Number.isNaN(ts) || Math.abs(now.getTime() - ts) > SIGNATURE_WINDOW_MS) {
    // Distinct code so the CLI can tell the user to fix their clock instead of
    // reporting a generic failure (design §6.2).
    return { ok: false, reason: "timestamp_out_of_window" };
  }

  const message = signedMessage({
    method: input.method,
    path: input.path,
    timestamp,
    nonce,
    bodyText: input.bodyText,
  });

  let valid = false;
  try {
    const pub = createPublicKey({
      key: Buffer.from(device.publicKey),
      format: "der",
      type: "spki",
    });
    valid = verify(null, Buffer.from(message, "utf8"), pub, Buffer.from(signature, "base64"));
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: "invalid_signature" };

  // Replay guard. Recorded only after the signature checks out, so an
  // unauthenticated caller cannot flood the table. skipDuplicates maps to
  // ON CONFLICT DO NOTHING, which does not abort the surrounding statement.
  const recorded = await db.collectorNonce.createMany({
    data: [{ deviceId: device.id, nonce, seenAt: now }],
    skipDuplicates: true,
  });
  if (recorded.count === 0) return { ok: false, reason: "replayed_nonce" };

  return { ok: true, deviceId: device.id };
}
