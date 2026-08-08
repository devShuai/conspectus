import { db } from "@/server/db";
import { normalizeEmail } from "./email";
import {
  assertStrongPassword,
  hashPassword,
  verifyPassword,
} from "./password";
import { createPersistentSession } from "./session-db";
import { loadCredentialKeyring } from "./crypto";

export const MAX_FAILED_LOGINS = 5;
export const LOCK_DURATION_MS = 15 * 60 * 1000;

export class LocalAuthError extends Error {
  constructor(
    public readonly code:
      | "invalid_credentials"
      | "account_locked"
      | "account_suspended"
      | "email_taken"
      | "registration_disabled"
      | "email_not_verified",
    message: string,
  ) {
    super(message);
    this.name = "LocalAuthError";
  }
}

function registrationEnabled(environment: Record<string, string | undefined>): boolean {
  return environment.LOCAL_REGISTRATION_ENABLED === "true";
}

export async function registerLocalUser(input: {
  email: string;
  password: string;
  environment?: Record<string, string | undefined>;
}): Promise<{ userId: string }> {
  if (!registrationEnabled(input.environment ?? process.env)) {
    throw new LocalAuthError("registration_disabled", "registration is disabled");
  }
  assertStrongPassword(input.password);
  const email = normalizeEmail(input.email);
  const passwordHash = await hashPassword(input.password);

  try {
    const user = await db.user.create({
      data: {
        email,
        passwordHash,
        // unverified until email verification flow completes
      },
    });
    return { userId: user.id };
  } catch (cause) {
    const err = cause as { code?: string };
    if (err.code === "P2002") {
      throw new LocalAuthError("email_taken", "email already registered");
    }
    throw cause;
  }
}

/**
 * Login with enumeration-resistant response: identical error for
 * "no such account" and "wrong password" (plus same timing path).
 */
export async function loginLocalUser(input: {
  email: string;
  password: string;
  now?: Date;
}): Promise<{ token: string; userId: string; sessionExpiresAt: number } | null> {
  const now = input.now ?? new Date();
  const email = normalizeEmail(input.email);
  const user = await db.user.findFirst({
    where: { email, passwordHash: { not: null } },
  });

  // Uniform failure: no account → still verify against a dummy hash to
  // equalize timing.
  const dummyHash = "$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const ok = user
    ? await verifyPassword(input.password, user.passwordHash ?? dummyHash)
    : (await verifyPassword(input.password, dummyHash), false);

  if (!user || !ok) {
    if (user) {
      await registerFailedAttempt(user.id, now);
    }
    throw new LocalAuthError("invalid_credentials", "invalid credentials");
  }

  if (user.status === "suspended") {
    throw new LocalAuthError("account_suspended", "account is suspended");
  }

  if (user.lockedUntil && user.lockedUntil > now) {
    throw new LocalAuthError("account_locked", "account temporarily locked");
  }

  const keyring = loadCredentialKeyring();
  const session = await db.$transaction(async (tx) => {
    const reset = await tx.user.updateMany({
      where: { id: user.id, status: "active" },
      data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: now },
    });
    if (reset.count !== 1) {
      throw new LocalAuthError("account_suspended", "account is suspended");
    }
    return createPersistentSession(
      {
        userId: user.id,
        authMethod: "local",
        now,
      },
      { client: tx, keyring },
    );
  });
  return {
    token: session.token,
    userId: session.userId,
    sessionExpiresAt: session.expiresAt.getTime(),
  };
}

async function registerFailedAttempt(userId: string, now: Date): Promise<void> {
  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user) return;
  const count = user.failedLoginCount + 1;
  const locked = count >= MAX_FAILED_LOGINS;
  await db.user.update({
    where: { id: userId },
    data: {
      failedLoginCount: count,
      lockedUntil: locked ? new Date(now.getTime() + LOCK_DURATION_MS) : user.lockedUntil,
    },
  });
}

export { registrationEnabled };
