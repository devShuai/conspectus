import { randomBytes, createHash } from "node:crypto";

import { db } from "@/server/db";

export const REAUTH_TTL_MS = 5 * 60 * 1000;

export interface ReauthCreateInput {
  userId: string;
  sessionId: string;
  action: string;
  now?: Date;
}

export interface ReauthTransactionHandle {
  token: string;
  transactionId: string;
  expiresAt: Date;
}

function hashToken(token: string): Uint8Array<ArrayBuffer> {
  const digest = createHash("sha256").update(token, "utf8").digest();
  return new Uint8Array(digest.buffer as ArrayBuffer, digest.byteOffset, digest.byteLength);
}

/** Create a one-time reauth transaction bound to user+session+action. */
export async function createReauthTransaction(
  input: ReauthCreateInput,
): Promise<ReauthTransactionHandle> {
  const now = input.now ?? new Date();
  const token = randomBytes(32).toString("base64url");
  const transaction = await db.reauthTransaction.create({
    data: {
      userId: input.userId,
      sessionId: input.sessionId,
      action: input.action,
      tokenHash: hashToken(token),
      expiresAt: new Date(now.getTime() + REAUTH_TTL_MS),
    },
  });
  return { token, transactionId: transaction.id, expiresAt: transaction.expiresAt };
}

/**
 * CAS mark verified after a successful re-auth round trip.
 * Must be called by the reauth callback AFTER verifying:
 *  - ID Token auth_time >= createdAt
 *  - returned sub === User.certusSub (same account, not a switched one)
 */
export async function verifyReauthTransaction(input: {
  token: string;
  sessionId: string;
  userId: string;
  action: string;
  now?: Date;
}): Promise<boolean> {
  const now = input.now ?? new Date();
  const result = await db.reauthTransaction.updateMany({
    where: {
      tokenHash: hashToken(input.token),
      sessionId: input.sessionId,
      userId: input.userId,
      action: input.action,
      verifiedAt: null,
      consumedAt: null,
      expiresAt: { gt: now },
    },
    data: { verifiedAt: now },
  });
  return result.count === 1;
}

/**
 * CAS consume by the target Server Action. Only succeeds once, bound to the
 * exact session/user/action, and only after verifiedAt was set.
 */
export async function consumeReauthTransaction(input: {
  token: string;
  sessionId: string;
  userId: string;
  action: string;
  now?: Date;
}): Promise<boolean> {
  const now = input.now ?? new Date();
  const result = await db.reauthTransaction.updateMany({
    where: {
      tokenHash: hashToken(input.token),
      sessionId: input.sessionId,
      userId: input.userId,
      action: input.action,
      verifiedAt: { not: null },
      consumedAt: null,
      expiresAt: { gt: now },
    },
    data: { consumedAt: now },
  });
  return result.count === 1;
}

/** Terminate a transaction (identity mismatch / replay / expiry). */
export async function terminateReauthTransaction(token: string): Promise<void> {
  await db.reauthTransaction.updateMany({
    where: { tokenHash: hashToken(token) },
    data: { consumedAt: new Date() },
  });
}

/** Read a transaction by its plain token (reauth callback: auth_time / sub comparison). */
export async function findReauthTransaction(token: string): Promise<{
  id: string;
  userId: string;
  sessionId: string;
  action: string;
  createdAt: Date;
  expiresAt: Date;
  verifiedAt: Date | null;
  consumedAt: Date | null;
} | null> {
  return db.reauthTransaction.findFirst({
    where: { tokenHash: hashToken(token) },
    select: {
      id: true,
      userId: true,
      sessionId: true,
      action: true,
      createdAt: true,
      expiresAt: true,
      verifiedAt: true,
      consumedAt: true,
    },
  });
}
