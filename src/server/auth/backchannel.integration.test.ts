import { describe, expect, it } from "vitest";

import { db } from "@/server/db";
import { legacyDerivedSubject } from "./claims";
import { upsertCertusUser } from "./jit-user";
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
    const replayJti = `jti-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    await db.$transaction(async (tx) => {
      await tx.backchannelLogoutReplay.create({
        data: {
          issuer: "https://certus.devshuai.com",
          jti: replayJti,
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
        jti: replayJti,
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
    const purgePrefix = `purge-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    await db.backchannelLogoutReplay.create({
      data: {
        issuer: "issuer",
        jti: `${purgePrefix}-expired`,
        expiresAt: new Date(Date.now() - 1000),
      },
    });
    await db.backchannelLogoutReplay.create({
      data: {
        issuer: "issuer",
        jti: `${purgePrefix}-alive`,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    const result = await runPurge();
    expect(result.sessions).toBeGreaterThanOrEqual(1);
    expect(await db.session.findUnique({ where: { id: expired.sessionId } })).toBeNull();
    expect(await db.session.findUnique({ where: { id: alive.sessionId } })).not.toBeNull();

    const jtis = await db.backchannelLogoutReplay.findMany({
      where: { issuer: "issuer", jti: { startsWith: purgePrefix } },
      select: { jti: true },
    });
    expect(jtis.map((r) => r.jti)).toEqual([`${purgePrefix}-alive`]);

    await db.session.deleteMany({ where: { userId: user.id } });
    await db.user.delete({ where: { id: user.id } });
  });
});

describe.skipIf(DISABLED)("certusSub stores certus's raw sub (#94)", () => {
  it("sub fallback deletes sessions for the raw sub from the logout_token", async () => {
    // Before #94 the column held a digest, so this lookup never matched and the
    // sub fallback silently deleted nothing.
    const rawSub = uniqueSub("raw-sub");
    const user = await db.user.create({
      data: {
        certusSub: rawSub,
        certusLinkStatus: "active",
        lastStatusSyncedAt: new Date(),
      },
    });
    await createPersistentSession({ userId: user.id, authMethod: "certus" });
    await createPersistentSession({ userId: user.id, authMethod: "local" });

    const found = await db.user.findUnique({ where: { certusSub: rawSub } });
    expect(found?.id).toBe(user.id);

    // sub fallback: only certus sessions go (design §7.1)
    await db.session.deleteMany({ where: { userId: user.id, authMethod: "certus" } });
    expect(await db.session.count({ where: { userId: user.id } })).toBe(1);
  });

  it("adopts a pre-#94 digest row instead of provisioning a second account", async () => {
    const rawSub = uniqueSub("legacy-raw");
    const digest = legacyDerivedSubject("https://certus.test", rawSub);
    const legacyRow = await db.user.create({
      data: {
        certusSub: digest,
        certusSubLegacy: digest,
        certusLinkStatus: "active",
        lastStatusSyncedAt: new Date(),
        name: "existing",
      },
    });

    const { userId } = await upsertCertusUser({ sub: rawSub, legacySub: digest });

    // same row, upgraded in place -- no orphaned duplicate
    expect(userId).toBe(legacyRow.id);
    const after = await db.user.findUniqueOrThrow({ where: { id: legacyRow.id } });
    expect(after.certusSub).toBe(rawSub);
    expect(after.certusSubLegacy).toBeNull();
    expect(after.name).toBe("existing");
    expect(await db.user.count({ where: { certusSub: digest } })).toBe(0);
  });
});
