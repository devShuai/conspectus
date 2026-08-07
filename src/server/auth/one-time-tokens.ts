import { createHash, randomBytes } from "node:crypto";

import { db } from "@/server/db";

export const TOKEN_TTL_MS = 30 * 60 * 1000;

export class TokenError extends Error {
  constructor(public readonly code: "invalid" | "expired" | "used") {
    super(code);
    this.name = "TokenError";
  }
}

function hashToken(token: string): Uint8Array<ArrayBuffer> {
  const digest = createHash("sha256").update(token, "utf8").digest();
  return new Uint8Array(digest.buffer as ArrayBuffer, digest.byteOffset, digest.byteLength);
}

function issueRawToken(): string {
  return randomBytes(32).toString("base64url");
}

export async function issuePasswordResetToken(
  userId: string,
  now: Date = new Date(),
): Promise<string> {
  const token = issueRawToken();
  await db.passwordResetToken.create({
    data: {
      userId,
      tokenHash: hashToken(token),
      expiresAt: new Date(now.getTime() + TOKEN_TTL_MS),
    },
  });
  return token;
}

/** Consume a reset token once; on success revoke all the user's sessions. */
export async function consumePasswordResetToken(
  token: string,
  now: Date = new Date(),
): Promise<{ userId: string }> {
  const row = await db.passwordResetToken.findUnique({
    where: { tokenHash: hashToken(token) },
  });
  if (!row) throw new TokenError("invalid");
  if (row.usedAt) throw new TokenError("used");
  if (row.expiresAt <= now) throw new TokenError("expired");

  await db.$transaction(async (tx) => {
    const consumed = await tx.passwordResetToken.updateMany({
      where: { id: row.id, usedAt: null },
      data: { usedAt: now },
    });
    if (consumed.count !== 1) throw new TokenError("used");
    await tx.session.deleteMany({ where: { userId: row.userId } });
  });
  return { userId: row.userId };
}

export async function issueEmailVerificationToken(
  userId: string,
  email: string,
  now: Date = new Date(),
): Promise<string> {
  const token = issueRawToken();
  await db.emailVerificationToken.create({
    data: {
      userId,
      email,
      tokenHash: hashToken(token),
      expiresAt: new Date(now.getTime() + TOKEN_TTL_MS),
    },
  });
  return token;
}

/** Consume a verification token; marks email verified for local accounts. */
export async function consumeEmailVerificationToken(
  token: string,
  now: Date = new Date(),
): Promise<{ userId: string; email: string }> {
  const row = await db.emailVerificationToken.findUnique({
    where: { tokenHash: hashToken(token) },
  });
  if (!row) throw new TokenError("invalid");
  if (row.usedAt) throw new TokenError("used");
  if (row.expiresAt <= now) throw new TokenError("expired");

  await db.$transaction(async (tx) => {
    const consumed = await tx.emailVerificationToken.updateMany({
      where: { id: row.id, usedAt: null },
      data: { usedAt: now },
    });
    if (consumed.count !== 1) throw new TokenError("used");
    await tx.user.update({
      where: { id: row.userId },
      data: {
        emailVerifiedAt: now,
        emailVerificationSource: "local",
      },
    });
  });
  return { userId: row.userId, email: row.email };
}
