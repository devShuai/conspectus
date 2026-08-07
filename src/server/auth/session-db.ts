import { createHash, randomBytes } from "node:crypto";

import type { Prisma } from "@prisma/client";

import { db } from "@/server/db";
import {
  decryptCredential,
  encryptCredential,
  loadCredentialKeyring,
  type CredentialKeyring,
} from "./crypto";

export const SESSION_IDLE_TTL_MS = 8 * 60 * 60 * 1000;
export const SESSION_ABSOLUTE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Refresh / ID token cipher columns require this many bytes of SHA-256 token hash. */
const TOKEN_HASH_BYTES = 32;

export interface PersistentSession {
  id: string;
  userId: string;
  certusSid: string | null;
  tokenHash: Uint8Array;
  authMethod: "certus" | "local";
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
  lastSeenAt: Date;
  lastIdentityCheckedAt: Date | null;
  authTime: Date;
  certusRefreshTokenCipher: Uint8Array | null;
  certusIdTokenCipher: Uint8Array | null;
}

export interface CreateSessionInput {
  userId: string;
  authMethod: "certus" | "local";
  certusSid?: string | null;
  refreshToken?: string | null;
  idToken?: string | null;
  now?: Date;
}

export function tokenHashOf(token: string): Buffer {
  return Buffer.from(createHash("sha256").update(token, "utf8").digest());
}

function randomSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Persisted opaque Session store. Tokens are only ever stored as SHA-256;
 * certus refresh / ID token ciphertext is stored encrypted under the keyring.
 */
export async function createPersistentSession(
  input: CreateSessionInput,
  options: { client?: Prisma.TransactionClient; keyring?: CredentialKeyring } = {},
): Promise<{ sessionId: string; token: string; userId: string; expiresAt: Date }> {
  const now = input.now ?? new Date();
  const token = randomSessionToken();
  const tokenHash = tokenHashOf(token);
  const keyring = options.keyring ?? loadCredentialKeyring();

  const data: Prisma.SessionUncheckedCreateInput = {
    userId: input.userId,
    tokenHash: toStoredBytes(tokenHashOf(token)),
    authMethod: input.authMethod,
    idleExpiresAt: new Date(now.getTime() + SESSION_IDLE_TTL_MS),
    absoluteExpiresAt: new Date(now.getTime() + SESSION_ABSOLUTE_TTL_MS),
    lastSeenAt: now,
    authTime: now,
    certusSid: input.certusSid ?? null,
    certusRefreshTokenCipher: input.refreshToken
        ? toStoredBytes(encryptCredential(Buffer.from(input.refreshToken, "utf8"), keyring))
        : null,
    certusIdTokenCipher: input.idToken
        ? toStoredBytes(encryptCredential(Buffer.from(input.idToken, "utf8"), keyring))
        : null,
  };

  const session = await (options.client ?? db).session.create({ data });
  return {
    sessionId: session.id,
    token,
    userId: session.userId,
    expiresAt: session.absoluteExpiresAt,
  };
}

export async function findPersistentSession(
  token: string | undefined,
  now: Date = new Date(),
): Promise<PersistentSession | null> {
  if (!token) return null;
  const tokenHash = toStoredBytes(tokenHashOf(token));
  const session = await db.session.findUnique({ where: { tokenHash } });
  if (!session) return null;

  if (
    session.absoluteExpiresAt <= now ||
    session.idleExpiresAt <= now
  ) {
    // Expired: fail-closed, remove the row so the cookie can never revive.
    await db.session.delete({ where: { id: session.id } }).catch(() => undefined);
    return null;
  }

  // Roll idle expiry on valid use (write is idempotent; harmless on races).
  const rolled = now.getTime() + SESSION_IDLE_TTL_MS;
  if (session.idleExpiresAt.getTime() - now.getTime() < SESSION_IDLE_TTL_MS / 2) {
    await db.session
      .update({
        where: { id: session.id },
        data: { lastSeenAt: now, idleExpiresAt: new Date(rolled) },
      })
      .catch(() => undefined);
  }
  return session;
}

export async function deletePersistentSession(
  token: string | undefined,
): Promise<void> {
  if (!token) return;
  await db.session.deleteMany({ where: { tokenHash: toStoredBytes(tokenHashOf(token)) } });
}

export function toStoredBytes(value: Buffer): Uint8Array<ArrayBuffer> {
  return new Uint8Array(value.buffer as ArrayBuffer, value.byteOffset, value.byteLength);
}

export async function deleteSessionsBySid(sid: string): Promise<number> {
  const result = await db.session.deleteMany({
    where: { certusSid: sid, authMethod: "certus" },
  });
  return result.count;
}

export async function deleteCertusSessionsBySub(sub: string): Promise<number> {
  const users = await db.user.findMany({
    where: { certusSub: sub },
    select: { id: true },
  });
  const result = await db.session.deleteMany({
    where: {
      userId: { in: users.map((u) => u.id) },
      authMethod: "certus",
    },
  });
  return result.count;
}

export function decryptSessionTokenCipher(
  cipher: Uint8Array | null,
  keyring: CredentialKeyring = loadCredentialKeyring(),
): string | null {
  if (!cipher) return null;
  return decryptCredential(cipher, keyring).toString("utf8");
}

export function encryptSessionTokenCipher(
  plaintext: string,
  keyring: CredentialKeyring = loadCredentialKeyring(),
): Buffer {
  return encryptCredential(Buffer.from(plaintext, "utf8"), keyring);
}

void TOKEN_HASH_BYTES;
