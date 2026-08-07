import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  type CipherGCMTypes,
} from "node:crypto";

const ALGORITHM: CipherGCMTypes = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface CredentialKeyring {
  activeKeyId: string;
  keys: Map<string, Buffer>;
}

export function loadCredentialKeyring(
  environment: Record<string, string | undefined> = process.env,
): CredentialKeyring {
  const raw = environment.CREDENTIAL_ENC_KEYS?.trim();
  const activeKeyId = environment.ACTIVE_CREDENTIAL_KEY_ID?.trim();
  if (!raw) {
    throw new Error("CREDENTIAL_ENC_KEYS is required");
  }
  if (!activeKeyId) {
    throw new Error("ACTIVE_CREDENTIAL_KEY_ID is required");
  }
  const keys = new Map<string, Buffer>();
  for (const entry of raw.split(",")) {
    const eq = entry.indexOf(":");
    if (eq <= 0) {
      throw new Error("CREDENTIAL_ENC_KEYS entries must be <keyId>:<base64>");
    }
    const keyId = entry.slice(0, eq).trim();
    const encoded = entry.slice(eq + 1).trim();
    const key = Buffer.from(encoded, "base64");
    if (key.length !== 32) {
      throw new Error(`CREDENTIAL_ENC_KEYS key ${keyId} must decode to 32 bytes`);
    }
    keys.set(keyId, key);
  }
  if (!keys.has(activeKeyId)) {
    throw new Error("ACTIVE_CREDENTIAL_KEY_ID not present in CREDENTIAL_ENC_KEYS");
  }
  return { activeKeyId, keys };
}

export function encryptCredential(
  plaintext: Buffer,
  keyring: CredentialKeyring,
): Buffer {
  const key = keyring.keys.get(keyring.activeKeyId);
  if (!key) {
    throw new Error("active credential key missing");
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return pack(keyring.activeKeyId, iv, tag, ciphertext);
}

export function decryptCredential(
  blob: Uint8Array | Buffer,
  keyring: CredentialKeyring,
): Buffer {
  const { keyId, iv, tag, ciphertext } = unpack(blob);
  const key = keyring.keys.get(keyId);
  if (!key) {
    throw new Error(`credential key ${keyId} not in keyring`);
  }
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function pack(keyId: string, iv: Buffer, tag: Buffer, ciphertext: Buffer): Buffer {
  const keyIdBytes = Buffer.from(keyId, "utf8");
  const header = Buffer.alloc(2 + 1 + keyIdBytes.length);
  header.writeUInt16BE(keyIdBytes.length, 0);
  header.writeUInt8(1, 2); // format version
  keyIdBytes.copy(header, 3);
  return Buffer.concat([header, iv, tag, ciphertext]);
}

function unpack(blob: Uint8Array | Buffer): {
  keyId: string;
  iv: Buffer;
  tag: Buffer;
  ciphertext: Buffer;
} {
  const bytes = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  if (bytes.length < 2 + 1 + 1 + IV_BYTES + TAG_BYTES) {
    throw new Error("credential blob too short");
  }
  const keyIdLength = bytes.readUInt16BE(0);
  const version = bytes.readUInt8(2);
  if (version !== 1) {
    throw new Error(`unsupported credential blob version ${version}`);
  }
  const keyId = bytes.subarray(3, 3 + keyIdLength).toString("utf8");
  const iv = bytes.subarray(3 + keyIdLength, 3 + keyIdLength + IV_BYTES);
  const tag = bytes.subarray(
    3 + keyIdLength + IV_BYTES,
    3 + keyIdLength + IV_BYTES + TAG_BYTES,
  );
  const ciphertext = bytes.subarray(3 + keyIdLength + IV_BYTES + TAG_BYTES);
  return { keyId, iv, tag, ciphertext };
}
