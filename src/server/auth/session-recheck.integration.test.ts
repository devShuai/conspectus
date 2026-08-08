import { describe, expect, it } from "vitest";

import { db } from "@/server/db";

import type { OIDCProvider } from "./provider";
import { createPersistentSession, decryptSessionTokenCipher } from "./session-db";
import { maybeRecheckSession, SESSION_RECHECK_INTERVAL_MS } from "./session-recheck";

const DISABLED = !process.env.TEST_DATABASE_URL;

function uniqueSub(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function setupUser() {
  return db.user.create({
    data: {
      certusSub: uniqueSub("n112"),
      certusLinkStatus: "active",
      lastStatusSyncedAt: new Date(),
    },
  });
}

function fakeProvider(
  impl: (refreshToken: string) => Promise<{ refreshToken?: string; idToken?: string }>,
) {
  const state = { calls: 0 };
  const provider = {
    createRequestSecurity: () => Promise.reject(new Error("unused")),
    buildAuthorizationURL: () => Promise.reject(new Error("unused")),
    exchangeAuthorizationCode: () => Promise.reject(new Error("unused")),
    refreshTokens: (_config: unknown, refreshToken: string) => {
      state.calls++;
      return impl(refreshToken);
    },
  } as unknown as OIDCProvider;
  return { provider, state };
}

describe.skipIf(DISABLED)("session recheck (§7.1 / #112)", () => {
  it("skips sessions checked within 15 minutes", async () => {
    const user = await setupUser();
    const session = await createPersistentSession({
      userId: user.id,
      authMethod: "certus",
      refreshToken: "rt-old",
    });
    const { provider, state } = fakeProvider(() => Promise.resolve({}));

    const outcome = await maybeRecheckSession(session.sessionId, new Date(), provider);
    expect(outcome).toBe("fresh");
    expect(state.calls).toBe(0);

    await db.user.delete({ where: { id: user.id } });
  });

  it("rotates the refresh token and stamps lastIdentityCheckedAt when stale", async () => {
    const user = await setupUser();
    const session = await createPersistentSession({
      userId: user.id,
      authMethod: "certus",
      refreshToken: "rt-old",
    });
    const stale = new Date(Date.now() - SESSION_RECHECK_INTERVAL_MS - 60_000);
    await db.session.update({
      where: { id: session.sessionId },
      data: { lastIdentityCheckedAt: stale },
    });
    const { provider, state } = fakeProvider((rt) => {
      expect(rt).toBe("rt-old");
      return Promise.resolve({ refreshToken: "rt-new", idToken: "idt-new" });
    });

    const now = new Date();
    const outcome = await maybeRecheckSession(session.sessionId, now, provider);
    expect(outcome).toBe("rotated");
    expect(state.calls).toBe(1);

    const after = await db.session.findUniqueOrThrow({ where: { id: session.sessionId } });
    expect(after.lastIdentityCheckedAt?.getTime()).toBe(now.getTime());
    expect(decryptSessionTokenCipher(after.certusRefreshTokenCipher)).toBe("rt-new");
    expect(decryptSessionTokenCipher(after.certusIdTokenCipher)).toBe("idt-new");

    await db.user.delete({ where: { id: user.id } });
  });

  it("invalid_grant destroys only that session and never suspends the user", async () => {
    const user = await setupUser();
    const doomed = await createPersistentSession({
      userId: user.id,
      authMethod: "certus",
      refreshToken: "rt-revoked",
    });
    const other = await createPersistentSession({
      userId: user.id,
      authMethod: "certus",
      refreshToken: "rt-fine",
    });
    await db.session.update({
      where: { id: doomed.sessionId },
      data: { lastIdentityCheckedAt: new Date(Date.now() - SESSION_RECHECK_INTERVAL_MS) },
    });
    const { provider } = fakeProvider(() =>
      Promise.reject(Object.assign(new Error("invalid_grant"), { error: "invalid_grant" })),
    );

    const outcome = await maybeRecheckSession(doomed.sessionId, new Date(), provider);
    expect(outcome).toBe("destroyed");
    expect(await db.session.findUnique({ where: { id: doomed.sessionId } })).toBeNull();
    // 只销毁对应 Session：其他会话与用户状态不受影响（§6.2 令牌≠停用）
    expect(await db.session.findUnique({ where: { id: other.sessionId } })).not.toBeNull();
    const after = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.status).toBe("active");

    await db.user.delete({ where: { id: user.id } });
  });

  it("network failure is fail-open: session survives with a 15-minute backoff", async () => {
    const user = await setupUser();
    const session = await createPersistentSession({
      userId: user.id,
      authMethod: "certus",
      refreshToken: "rt-old",
    });
    await db.session.update({
      where: { id: session.sessionId },
      data: { lastIdentityCheckedAt: new Date(Date.now() - SESSION_RECHECK_INTERVAL_MS) },
    });
    const { provider, state } = fakeProvider(() =>
      Promise.reject(new TypeError("fetch failed")),
    );

    const now = new Date();
    const outcome = await maybeRecheckSession(session.sessionId, now, provider);
    expect(outcome).toBe("unreachable");
    const after = await db.session.findUniqueOrThrow({ where: { id: session.sessionId } });
    expect(after.lastIdentityCheckedAt?.getTime()).toBe(now.getTime());
    // 故障窗口内不再重试
    const again = await maybeRecheckSession(session.sessionId, now, provider);
    expect(again).toBe("fresh");
    expect(state.calls).toBe(1);

    await db.user.delete({ where: { id: user.id } });
  });

  it("concurrent rechecks on the same session rotate exactly once", async () => {
    const user = await setupUser();
    const session = await createPersistentSession({
      userId: user.id,
      authMethod: "certus",
      refreshToken: "rt-old",
    });
    await db.session.update({
      where: { id: session.sessionId },
      data: { lastIdentityCheckedAt: new Date(Date.now() - SESSION_RECHECK_INTERVAL_MS) },
    });
    const { provider, state } = fakeProvider(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return { refreshToken: "rt-new" };
    });

    const now = new Date();
    const [a, b] = await Promise.all([
      maybeRecheckSession(session.sessionId, now, provider),
      maybeRecheckSession(session.sessionId, now, provider),
    ]);
    expect(state.calls).toBe(1);
    expect([a, b].sort()).toEqual(["fresh", "rotated"]);

    await db.user.delete({ where: { id: user.id } });
  });

  it("local sessions are never rechecked against certus", async () => {
    const user = await setupUser();
    const session = await createPersistentSession({
      userId: user.id,
      authMethod: "local",
    });
    const { provider, state } = fakeProvider(() => Promise.resolve({}));
    const outcome = await maybeRecheckSession(session.sessionId, new Date(), provider);
    expect(outcome).toBe("skipped");
    expect(state.calls).toBe(0);

    await db.user.delete({ where: { id: user.id } });
  });
});
