import { describe, expect, it } from "vitest";

import { db } from "@/server/db";
import { hashPassword } from "./password.js";
import {
  consumeEmailVerificationToken,
  consumePasswordResetToken,
  issueEmailVerificationToken,
  issuePasswordResetToken,
  TOKEN_TTL_MS,
  TokenError,
} from "./one-time-tokens.js";

const DISABLED = !process.env.TEST_DATABASE_URL;

function uniqueEmail(): string {
  return `tokens-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
}

describe.skipIf(DISABLED)("one-time tokens", () => {
  it("password reset token: single use, revokes sessions", async () => {
    const user = await db.user.create({
      data: {
        email: uniqueEmail(),
        passwordHash: await hashPassword("correct-horse-battery-9!"),
      },
    });
    const session = await db.session.create({
      data: {
        userId: user.id,
        tokenHash: Buffer.from(
          new Uint8Array(32).fill(
            (Date.now() % 250) + 2,
            0,
            32,
          ),
        ),
        authMethod: "local",
        idleExpiresAt: new Date(Date.now() + 3600_000),
        absoluteExpiresAt: new Date(Date.now() + 86_400_000),
        lastSeenAt: new Date(),
        authTime: new Date(),
      },
    });

    const token = await issuePasswordResetToken(user.id);
    const consumed = await consumePasswordResetToken(token);
    expect(consumed.userId).toBe(user.id);

    // session revoked
    expect(await db.session.findUnique({ where: { id: session.id } })).toBeNull();
    // replay rejected
    await expect(consumePasswordResetToken(token)).rejects.toThrow(TokenError);

    await db.user.delete({ where: { id: user.id } });
  });

  it("rejects expired tokens", async () => {
    const user = await db.user.create({
      data: {
        email: uniqueEmail(),
        passwordHash: await hashPassword("correct-horse-battery-9!"),
      },
    });
    const past = new Date(Date.now() - TOKEN_TTL_MS - 1000);
    const token = await issuePasswordResetToken(user.id, past);
    await expect(
      consumePasswordResetToken(token, new Date(Date.now() + 1000)),
    ).rejects.toThrow(TokenError);
    await db.user.delete({ where: { id: user.id } });
  });

  it("email verification marks local source verified once", async () => {
    const email = uniqueEmail();
    const user = await db.user.create({
      data: { email, passwordHash: await hashPassword("correct-horse-battery-9!") },
    });
    const token = await issueEmailVerificationToken(user.id, email);
    const result = await consumeEmailVerificationToken(token);
    expect(result.email).toBe(email);

    const updated = await db.user.findUnique({ where: { id: user.id } });
    expect(updated?.emailVerifiedAt).not.toBeNull();
    expect(updated?.emailVerificationSource).toBe("local");

    await expect(consumeEmailVerificationToken(token)).rejects.toThrow(TokenError);
    await db.user.delete({ where: { id: user.id } });
  });
});
