import { describe, expect, it } from "vitest";

import { db } from "@/server/db";
import { dbSessionWriter } from "./db-flow";
import { upsertCertusUser } from "./jit-user";
import {
  createPersistentSession,
  decryptSessionTokenCipher,
  deleteSessionsBySid,
  findPersistentSession,
  SESSION_ABSOLUTE_TTL_MS,
  SESSION_IDLE_TTL_MS,
  tokenHashOf,
} from "./session-db";
import { loadCredentialKeyring } from "./crypto";

const DISABLED = !process.env.TEST_DATABASE_URL;

function uniqueSub(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

describe.skipIf(DISABLED)("persistent sessions", () => {
  it("creates a session that survives a fresh lookup (new Prisma instance semantics)", async () => {
    const user = await db.user.create({
      data: {
        certusSub: uniqueSub("usr-persist-session-1"),
        certusLinkStatus: "active",
        lastStatusSyncedAt: new Date(),
      },
    });

    const created = await createPersistentSession({
      userId: user.id,
      authMethod: "certus",
      certusSid: "sid-abc",
      refreshToken: "refresh-value-1",
      idToken: "id-token-value-1",
    });

    // Simulate restart: fresh lookup by token hash (DB-backed, not process memory).
    const found = await findPersistentSession(created.token);
    expect(found?.userId).toBe(user.id);
    expect(found?.certusSid).toBe("sid-abc");
    expect(found?.authMethod).toBe("certus");

    // Token ciphertext decrypts and is not stored in plaintext.
    expect(
      Buffer.from(found?.certusRefreshTokenCipher ?? new Uint8Array()).toString(
        "utf8",
      ),
    ).not.toContain("refresh-value-1");
    const keyring = loadCredentialKeyring();
    expect(
      decryptSessionTokenCipher(found?.certusRefreshTokenCipher ?? null, keyring),
    ).toBe("refresh-value-1");
    expect(
      decryptSessionTokenCipher(found?.certusIdTokenCipher ?? null, keyring),
    ).toBe("id-token-value-1");

    await db.session.delete({ where: { id: created.sessionId } });
    await db.user.delete({ where: { id: user.id } });
  });

  it("expires after idle or absolute TTL", async () => {
    const user = await db.user.create({
      data: {
        certusSub: uniqueSub("usr-persist-session-2"),
        certusLinkStatus: "active",
        lastStatusSyncedAt: new Date(),
      },
    });

    const now = new Date();
    const created = await createPersistentSession(
      { userId: user.id, authMethod: "certus", now },
      {},
    );

    // absolute expiry
    const farFuture = new Date(now.getTime() + SESSION_ABSOLUTE_TTL_MS + 1000);
    expect(await findPersistentSession(created.token, farFuture)).toBeNull();
    // row was deleted fail-closed
    expect(await db.session.findUnique({ where: { id: created.sessionId } })).toBeNull();

    const created2 = await createPersistentSession(
      { userId: user.id, authMethod: "certus", now },
      {},
    );
    // idle expiry
    const idlePast = new Date(now.getTime() + SESSION_IDLE_TTL_MS + 1000);
    expect(await findPersistentSession(created2.token, idlePast)).toBeNull();

    await db.session.deleteMany({ where: { userId: user.id } });
    await db.user.delete({ where: { id: user.id } });
  });

  it("deletes sessions by sid only for certus method", async () => {
    const user = await db.user.create({
      data: {
        certusSub: uniqueSub("usr-persist-session-3"),
        certusLinkStatus: "active",
        lastStatusSyncedAt: new Date(),
      },
    });

    const certus = await createPersistentSession({
      userId: user.id,
      authMethod: "certus",
      certusSid: "sid-delete",
    });
    const local = await createPersistentSession({
      userId: user.id,
      authMethod: "local",
      certusSid: null,
    });

    const deleted = await deleteSessionsBySid("sid-delete");
    expect(deleted).toBe(1);
    // local session with null sid untouched
    expect(await findPersistentSession(local.token)).not.toBeNull();

    await db.session.deleteMany({ where: { userId: user.id } });
    await db.user.delete({ where: { id: user.id } });
  });

  it("hashes tokens with SHA-256 (32 bytes), never stores plaintext", async () => {
    const user = await db.user.create({
      data: {
        certusSub: uniqueSub("usr-persist-session-4"),
        certusLinkStatus: "active",
        lastStatusSyncedAt: new Date(),
      },
    });
    const created = await createPersistentSession({
      userId: user.id,
      authMethod: "certus",
    });

    const row = await db.session.findUnique({ where: { id: created.sessionId } });
    const storedHash = row ? Buffer.from(row.tokenHash) : null;
    expect(storedHash?.equals(tokenHashOf(created.token))).toBe(true);
    expect(storedHash?.length).toBe(32);
    expect(storedHash?.toString("utf8")).not.toContain(created.token);

    await db.session.delete({ where: { id: created.sessionId } });
    await db.user.delete({ where: { id: user.id } });
  });
});

describe.skipIf(DISABLED)("JIT certus user", () => {
  it("reuses the same User row for the same certus sub", async () => {
    const a = await upsertCertusUser({ sub: "usr-jit-same" });
    const b = await upsertCertusUser({ sub: "usr-jit-same" });
    expect(a.userId).toBe(b.userId);

    await db.user.delete({ where: { id: a.userId } });
  });

  it("never merges by email: same email different sub creates separate users", async () => {
    const a = await upsertCertusUser({
      sub: "usr-jit-a",
      email: "shared@example.com",
      emailVerified: true,
    });
    const b = await upsertCertusUser({
      sub: "usr-jit-b",
      email: "shared@example.com",
      emailVerified: false,
    });
    expect(a.userId).not.toBe(b.userId);
    expect(a.user.email).toBe("shared@example.com");
    expect(b.user.email).toBe("shared@example.com");
    expect(a.user.emailVerifiedAt).not.toBeNull();

    await db.user.delete({ where: { id: a.userId } });
    await db.user.delete({ where: { id: b.userId } });
  });

  it("clears verification proof when the email address changes", async () => {
    const first = await upsertCertusUser({
      sub: "usr-jit-email-change",
      email: "old@example.com",
      emailVerified: true,
    });
    expect(first.user.emailVerifiedAt).not.toBeNull();

    const second = await upsertCertusUser({
      sub: "usr-jit-email-change",
      email: "new@example.com",
      emailVerified: false,
    });
    expect(second.user.email).toBe("new@example.com");
    expect(second.user.emailVerifiedAt).toBeNull();
    expect(second.user.emailVerificationSource).toBeNull();

    await db.user.delete({ where: { id: second.userId } });
  });

  it("dbSessionWriter creates a session and validates after restart semantics", async () => {
    const sub = uniqueSub("usr-writer-e2e");
    const created = await dbSessionWriter.create({
      identity: {
        certusSub: sub,
        email: "writer@example.com",
        emailVerified: true,
        idTokenIat: Math.floor(Date.now() / 1000),
      },
      derivedUserId: "usr_writer_derived",
      refreshToken: "rt",
      idToken: "idt",
    });

    const found = await dbSessionWriter.find(created.sessionToken);
    expect(found?.userId).toBe(created.userId);
    expect(found?.userId).not.toBe("usr_writer_derived"); // DB uuid, not derived

    await dbSessionWriter.delete(created.sessionToken);
    expect(await dbSessionWriter.find(created.sessionToken)).toBeNull();
    await db.user.delete({ where: { certusSub: sub } });
  });
});
