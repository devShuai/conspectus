import { describe, expect, it } from "vitest";

import {
  decryptCredential,
  encryptCredential,
  loadCredentialKeyring,
} from "./crypto";

const key = Buffer.alloc(32, 7).toString("base64");
const env = {
  CREDENTIAL_ENC_KEYS: `v2:${key},v1:${key}`,
  ACTIVE_CREDENTIAL_KEY_ID: "v2",
};

describe("credential keyring", () => {
  it("loads keys and requires active key present", () => {
    const keyring = loadCredentialKeyring(env);
    expect(keyring.activeKeyId).toBe("v2");
    expect(keyring.keys.size).toBe(2);
  });

  it("rejects invalid key sizes and unknown active key", () => {
    expect(() =>
      loadCredentialKeyring({
        ...env,
        CREDENTIAL_ENC_KEYS: `v2:${Buffer.alloc(16, 1).toString("base64")}`,
      }),
    ).toThrow(/32 bytes/);
    expect(() =>
      loadCredentialKeyring({ ...env, ACTIVE_CREDENTIAL_KEY_ID: "v9" }),
    ).toThrow(/not present/);
  });
});

describe("credential envelope", () => {
  it("round-trips plaintext and does not store key material inline", () => {
    const keyring = loadCredentialKeyring(env);
    const plaintext = Buffer.from("refresh-token-value", "utf8");
    const blob = encryptCredential(plaintext, keyring);

    expect(decryptCredential(blob, keyring).toString("utf8")).toBe(
      "refresh-token-value",
    );
    expect(blob.toString("utf8")).not.toContain("refresh-token-value");
  });

  it("decrypts blobs written under a previous key id", () => {
    const keyring = loadCredentialKeyring(env);
    const oldKeyring = { activeKeyId: "v1", keys: keyring.keys };
    const blob = encryptCredential(Buffer.from("legacy"), oldKeyring);
    expect(decryptCredential(blob, keyring).toString("utf8")).toBe("legacy");
  });

  it("fails when the key id is absent from the keyring", () => {
    const keyring = loadCredentialKeyring(env);
    const blob = encryptCredential(Buffer.from("x"), keyring);
    expect(() =>
      decryptCredential(blob, { activeKeyId: "v1", keys: new Map() }),
    ).toThrow(/not in keyring/);
  });
});
