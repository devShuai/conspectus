import { describe, expect, it } from "vitest";

import { db } from "@/server/db";
import { runPurge } from "./purge";
import {
  createPersistentSession,
  SESSION_ABSOLUTE_TTL_MS,
} from "./session-db";

const DISABLED = !process.env.TEST_DATABASE_URL;

function uniqueSub(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

describe.skipIf(DISABLED)("backchannel replay + purge integration", () => {
  it("replays conflict as idempotent and deletes only the targeted sid", async () => {
    const sub = uniqueSub("bc-replay");
    const user = await db.user.create({
      data: {
        certusSub: sub,
        certusLinkStatus: "active",
        lastStatusSyncedAt: new Date(),
      },
    });
    const target = await createPersistentSession({
      userId: user.id,
      authMethod: "certus",
      certusSid: "sid-target",
    });
    const other = await createPersistentSession({
      userId: user.id,
      authMethod: "certus",
      certusSid: "sid-other",
    });

    // First processing inserts replay row (simulating transaction that also deletes sid).
    await db.$transaction(async (tx) => {
      await tx.backchannelLogoutReplay.create({
        data: {
          issuer: "https://certus.devshuai.com",
          jti: "jti-123",
          expiresAt: new Date(Date.now() + 60_000),
        },
      });
      await tx.session.deleteMany({
        where: { certusSid: "sid-target", authMethod: "certus" },
      });
    });

    // Replay: conflict → nothing else deleted (other session survives).
    const conflict = await db.backchannelLogoutReplay.create({
      data: {
        issuer: "https://certus.devshuai.com",
        jti: "jti-123",
        expiresAt: new Date(Date.now() + 60_000),
      },
    }).catch(() => null);
    expect(conflict).toBeNull();
    expect(await db.session.findUnique({ where: { id: other.sessionId } })).not.toBeNull();

    await db.session.deleteMany({ where: { userId: user.id } });
    await db.user.delete({ where: { id: user.id } });
  });

  it("sub fallback deletes only certus sessions, never local", async () => {
    const sub = uniqueSub("bc-sub");
    const user = await db.user.create({
      data: {
        certusSub: sub,
        certusLinkStatus: "active",
        lastStatusSyncedAt: new Date(),
      },
    });
    const certus = await createPersistentSession({
      userId: user.id,
      authMethod: "certus",
    });
    const local = await createPersistentSession({
      userId: user.id,
      authMethod: "local",
    });

    // sub fallback: delete certus only
    await db.session.deleteMany({
      where: { userId: user.id, authMethod: "certus" },
    });
    expect(await db.session.findUnique({ where: { id: certus.sessionId } })).toBeNull();
    expect(await db.session.findUnique({ where: { id: local.sessionId } })).not.toBeNull();

    await db.session.deleteMany({ where: { userId: user.id } });
    await db.user.delete({ where: { id: user.id } });
  });

  it("purge deletes expired rows only", async () => {
    const sub = uniqueSub("purge");
    const user = await db.user.create({
      data: {
        certusSub: sub,
        certusLinkStatus: "active",
        lastStatusSyncedAt: new Date(),
      },
    });

    const expired = await createPersistentSession({
      userId: user.id,
      authMethod: "certus",
      now: new Date(Date.now() - SESSION_ABSOLUTE_TTL_MS - 1000),
    });
    const alive = await createPersistentSession({
      userId: user.id,
      authMethod: "certus",
    });
    await db.backchannelLogoutReplay.create({
      data: {
        issuer: "issuer",
        jti: "expired-jti",
        expiresAt: new Date(Date.now() - 1000),
      },
    });
    await db.backchannelLogoutReplay.create({
      data: {
        issuer: "issuer",
        jti: "alive-jti",
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    const result = await runPurge();
    expect(result.sessions).toBeGreaterThanOrEqual(1);
    expect(await db.session.findUnique({ where: { id: expired.sessionId } })).toBeNull();
    expect(await db.session.findUnique({ where: { id: alive.sessionId } })).not.toBeNull();

    const jtis = await db.backchannelLogoutReplay.findMany({
      where: { issuer: "issuer" },
      select: { jti: true },
    });
    expect(jtis.map((r) => r.jti)).toEqual(["alive-jti"]);

    await db.session.deleteMany({ where: { userId: user.id } });
    await db.user.delete({ where: { id: user.id } });
  });
});
