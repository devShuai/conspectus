import { db } from "@/server/db";
import { hashPassword } from "./password";
import type { AuthConfig } from "./config";

export class BindError extends Error {
  constructor(
    public readonly code:
      | "sub_in_use"
      | "already_bound"
      | "last_auth_method"
      | "invalid_input",
    message: string,
  ) {
    super(message);
    this.name = "BindError";
  }
}

/** Bind a certus sub to the current local user (both-mode account merge). */
export async function bindCertusToUser(input: {
  userId: string;
  claims: Record<string, unknown>;
  config: AuthConfig;
}): Promise<void> {
  // Callers must pass a subject that came from an ID Token this server
  // obtained itself (see bind-flow.ts). Never accept one from client input.
  const sub = input.claims.sub;
  if (typeof sub !== "string" || !sub) {
    throw new BindError("invalid_input", "missing sub");
  }

  const user = await db.user.findUnique({ where: { id: input.userId } });
  if (!user) throw new BindError("invalid_input", "user not found");
  if (user.certusSub) throw new BindError("already_bound", "already bound to certus");

  const taken = await db.user.findUnique({ where: { certusSub: sub } });
  if (taken) throw new BindError("sub_in_use", "certus sub belongs to another account");

  await db.user.update({
    where: { id: user.id },
    data: {
      certusSub: sub,
      certusLinkStatus: "active",
      lastStatusSyncedAt: new Date(),
      name: typeof input.claims.name === "string" ? input.claims.name : user.name,
      email: typeof input.claims.email === "string" ? input.claims.email : user.email,
    },
  });
}

/** Unbind certus from a user; refuses when it is the only remaining login method. */
export async function unbindCertusFromUser(userId: string): Promise<void> {
  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user) throw new BindError("invalid_input", "user not found");
  if (!user.certusSub) throw new BindError("invalid_input", "not bound to certus");
  if (!user.passwordHash) {
    throw new BindError("last_auth_method", "cannot remove the last login method");
  }
  await db.user.update({
    where: { id: userId },
    data: {
      certusSub: null,
      certusLinkStatus: null,
      lastStatusSyncedAt: null,
      emailSyncRequiredAt: null,
    },
  });
  await db.session.deleteMany({ where: { userId, authMethod: "certus" } });
}

/** Unbind local password; refuses when it is the only remaining login method. */
export async function unbindLocalPasswordFromUser(userId: string): Promise<void> {
  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user) throw new BindError("invalid_input", "user not found");
  if (!user.passwordHash) throw new BindError("invalid_input", "no local password");
  if (!user.certusSub) {
    throw new BindError("last_auth_method", "cannot remove the last login method");
  }
  await db.user.update({
    where: { id: userId },
    data: {
      passwordHash: null,
      failedLoginCount: 0,
      lockedUntil: null,
    },
  });
  await db.session.deleteMany({ where: { userId, authMethod: "local" } });
}

/** Set a local password on a certus-only user (reverse binding). */
export async function setLocalPassword(
  userId: string,
  password: string,
): Promise<void> {
  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user) throw new BindError("invalid_input", "user not found");
  if (user.email && user.certusSub && !user.passwordHash) {
    const { assertStrongPassword } = await import("./password");
    assertStrongPassword(password);
    const passwordHash = await hashPassword(password);
    await db.user.update({ where: { id: userId }, data: { passwordHash } });
    return;
  }
  if (user.passwordHash) {
    throw new BindError("invalid_input", "local password already set");
  }
  throw new BindError("invalid_input", "cannot set local password without email");
}

