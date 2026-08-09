import { describe, expect, it } from "vitest";

import { db } from "@/server/db";
import { loadAuthConfig, type AuthConfig } from "@/server/auth/config";
import { identityGateOk, identityStatusLimits, recheckIdentityStatus } from "./identity-status";

const DISABLED = !process.env.TEST_DATABASE_URL;

function uniqueSub(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

describe.skipIf(DISABLED)("identity gate", () => {
  it("DB CHECK prevents certus user with NULL lastStatusSyncedAt (fail-closed at storage)", async () => {
    const user = await db.user.create({
      data: {
        certusSub: uniqueSub("gate-null"),
        certusLinkStatus: "active",
        lastStatusSyncedAt: new Date(),
      },
    });
    // The CHECK users_certus_sync_required rejects even raw SQL attempts,
    // proving NULL can never be introduced through normal paths.
    await expect(
      db.$executeRawUnsafe(
        `UPDATE users SET "lastStatusSyncedAt" = NULL WHERE id = '${user.id}'::uuid`,
      ),
    ).rejects.toThrow(/users_certus_sync_required/);
    await db.user.delete({ where: { id: user.id } });
  });

  it("blocks suspended and reauth_required users", async () => {
    const suspended = await db.user.create({
      data: {
        certusSub: uniqueSub("gate-susp"),
        certusLinkStatus: "active",
        lastStatusSyncedAt: new Date(),
        status: "suspended",
        statusReason: "certus_locked",
      },
    });
    const reauth = await db.user.create({
      data: {
        certusSub: uniqueSub("gate-reauth"),
        certusLinkStatus: "reauth_required",
        lastStatusSyncedAt: new Date(),
      },
    });
    expect((await identityGateOk(suspended.id)).ok).toBe(false);
    expect((await identityGateOk(reauth.id)).ok).toBe(false);
    await db.user.delete({ where: { id: suspended.id } });
    await db.user.delete({ where: { id: reauth.id } });
  });

  it("passes for fresh active users and fails when stale beyond MAX_STALE", async () => {
    const fresh = await db.user.create({
      data: {
        certusSub: uniqueSub("gate-fresh"),
        certusLinkStatus: "active",
        lastStatusSyncedAt: new Date(),
      },
    });
    const stale = await db.user.create({
      data: {
        certusSub: uniqueSub("gate-stale"),
        certusLinkStatus: "active",
        lastStatusSyncedAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
      },
    });
    expect((await identityGateOk(fresh.id)).ok).toBe(true);
    const staleResult = await identityGateOk(stale.id);
    expect(staleResult.ok).toBe(false);
    expect(staleResult.reason).toBe("identity_status_stale");
    await db.user.delete({ where: { id: fresh.id } });
    await db.user.delete({ where: { id: stale.id } });
  });

  it("honors the maxStaleMs passed in from startup config (#121-7)", async () => {
    // 2 小时未复核：maxStale=3h 放行，maxStale=1h 阻断——上界不再硬编码
    const user = await db.user.create({
      data: {
        certusSub: uniqueSub("gate-cfg"),
        certusLinkStatus: "active",
        lastStatusSyncedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      },
    });
    expect((await identityGateOk(user.id, new Date(), 3 * 60 * 60 * 1000)).ok).toBe(true);
    const denied = await identityGateOk(user.id, new Date(), 60 * 60 * 1000);
    expect(denied.ok).toBe(false);
    expect(denied.reason).toBe("identity_status_stale");
    await db.user.delete({ where: { id: user.id } });
  });

  it("recheck skips healthy users fresh within TTL without hitting certus (#121-7)", async () => {
    const user = await db.user.create({
      data: {
        certusSub: uniqueSub("gate-ttl"),
        certusLinkStatus: "active",
        lastStatusSyncedAt: new Date(),
      },
    });
    // config 传空对象也不会被触碰：TTL 内直接 skip，不发任何上游请求
    const outcome = await recheckIdentityStatus({
      userId: user.id,
      certusSub: user.certusSub!,
      config: {} as AuthConfig,
      ttlMs: 60 * 60 * 1000,
    });
    expect(outcome).toEqual({ kind: "skip", reason: "fresh_within_ttl" });
    await db.user.delete({ where: { id: user.id } });
  });

  it("identityStatusLimits falls back to parsed startup config values", () => {
    // .env.local 未设置 IDENTITY_STATUS_* 时即代码默认值（§12.4）
    const limits = identityStatusLimits();
    expect(limits.ttlMs).toBeGreaterThan(0);
    expect(limits.maxStaleMs).toBeGreaterThan(limits.ttlMs);
  });
});

void loadAuthConfig;
