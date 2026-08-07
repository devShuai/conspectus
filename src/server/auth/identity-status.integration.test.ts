import { describe, expect, it } from "vitest";

import { db } from "@/server/db";
import { loadAuthConfig } from "@/server/auth/config";
import { identityGateOk } from "./identity-status.js";

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
});

void loadAuthConfig;
