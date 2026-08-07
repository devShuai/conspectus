import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  randomUUID,
  sign,
} from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, platform } from "node:os";
import { resolve } from "node:path";
import { homedir } from "node:os";

import type { CliConfig } from "./config.js";
import { validAccessToken } from "./auth.js";

const CONFIG_DIR = resolve(homedir(), ".conspectus");
const DEVICE_FILE = resolve(CONFIG_DIR, "device.json");

interface StoredDevice {
  deviceId: string;
  /** PKCS#8 DER, base64. Local-only proof that a report came from this machine. */
  privateKey: string;
}

/**
 * Canonical signed message, mirrored from
 * src/server/usage/device-signature.ts. Both sides must agree exactly.
 */
function signedMessage(input: {
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  bodyText: string;
}): string {
  const bodyHash = createHash("sha256").update(input.bodyText).digest("hex");
  return [input.method, input.path, input.timestamp, input.nonce, bodyHash].join("\n");
}

function loadDevice(): StoredDevice | null {
  if (!existsSync(DEVICE_FILE)) return null;
  try {
    const raw = JSON.parse(readFileSync(DEVICE_FILE, "utf8")) as Partial<StoredDevice>;
    if (!raw.deviceId || !raw.privateKey) return null;
    return { deviceId: raw.deviceId, privateKey: raw.privateKey };
  } catch {
    return null;
  }
}

function storeDevice(device: StoredDevice): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(DEVICE_FILE, JSON.stringify(device, null, 2), { mode: 0o600 });
}

/**
 * Ensure this machine has a registered signing key.
 *
 * The private key never leaves the machine; the server only stores the public
 * half, which is what makes single-device revocation possible.
 */
export async function ensureDevice(config: CliConfig): Promise<StoredDevice> {
  const existing = loadDevice();
  if (existing) return existing;

  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const tokens = await validAccessToken(config);
  const response = await fetch(`${config.serverUrl}/api/collect/devices`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${tokens.accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      name: hostname(),
      platform: platform(),
      keyAlgorithm: "Ed25519",
      publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`device registration failed: ${response.status} ${text.slice(0, 200)}`);
  }
  const body = (await response.json()) as { deviceId?: string };
  if (!body.deviceId) throw new Error("device registration returned no deviceId");

  const device: StoredDevice = {
    deviceId: body.deviceId,
    privateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
  };
  storeDevice(device);
  return device;
}

export interface SignedHeaders {
  "x-device-id": string;
  "x-device-signature": string;
  "x-device-timestamp": string;
  "x-device-nonce": string;
}

/** Sign one request body; the nonce is single-use and rejected on replay. */
export function signRequest(
  device: StoredDevice,
  input: { method: string; path: string; bodyText: string },
): SignedHeaders {
  const timestamp = new Date().toISOString();
  const nonce = randomUUID();
  const key = createPrivateKey({
    key: Buffer.from(device.privateKey, "base64"),
    format: "der",
    type: "pkcs8",
  });
  const signature = sign(
    null,
    Buffer.from(signedMessage({ ...input, timestamp, nonce }), "utf8"),
    key,
  ).toString("base64");
  return {
    "x-device-id": device.deviceId,
    "x-device-signature": signature,
    "x-device-timestamp": timestamp,
    "x-device-nonce": nonce,
  };
}
