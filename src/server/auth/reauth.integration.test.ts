import { describe, expect, it } from "vitest";

import { db } from "@/server/db";
import {
  consumeReauthTransaction,
  createReauthTransaction,
  terminateReauthTransaction,
  verifyReauthTransaction,
} from "./reauth";

const DISABLED = !process.env.TEST_DATABASE_URL;

function uniqueSub(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

describe.skipIf(DISABLED)("reauth transaction", () => {
  it("verifies then consumes exactly once, bound to user+session+action", async () => {
    const user = await db.user.create({
      data: {
        certusSub: uniqueSub("reauth-1"),
        certusLinkStatus: "active",
        lastStatusSyncedAt: new Date(),
      },
    });
    const handle = await createReauthTransaction({
      userId: user.id,
      sessionId: "00000000-0000-0000-0000-00000000000a",
      action: "export",
      targetPath: "/settings/data",
    });

    // Wrong session cannot verify.
    expect(
      await verifyReauthTransaction({
        token: handle.token,
        sessionId: "00000000-0000-0000-0000-00000000000b",
        userId: user.id,
        action: "export",
      }),
    ).toBe(false);

    // Correct verify once.
    expect(
      await verifyReauthTransaction({
        token: handle.token,
        sessionId: "00000000-0000-0000-0000-00000000000a",
        userId: user.id,
        action: "export",
      }),
    ).toBe(true);

    // Consume once.
    expect(
      await consumeReauthTransaction({
        token: handle.token,
        sessionId: "00000000-0000-0000-0000-00000000000a",
        userId: user.id,
        action: "export",
      }),
    ).toBe(true);

    // Replay consume rejected.
    expect(
      await consumeReauthTransaction({
        token: handle.token,
        sessionId: "00000000-0000-0000-0000-00000000000a",
        userId: user.id,
        action: "export",
      }),
    ).toBe(false);

    // Wrong action rejected.
    const handle2 = await createReauthTransaction({
      userId: user.id,
      sessionId: "00000000-0000-0000-0000-00000000000a",
      action: "delete",
      targetPath: "/settings/data",
    });
    expect(
      await verifyReauthTransaction({
        token: handle2.token,
        sessionId: "00000000-0000-0000-0000-00000000000a",
        userId: user.id,
        action: "export",
      }),
    ).toBe(false);

    await db.reauthTransaction.deleteMany({ where: { userId: user.id } });
    await db.user.delete({ where: { id: user.id } });
  });

  it("rejects after expiry and supports termination", async () => {
    const user = await db.user.create({
      data: {
        certusSub: uniqueSub("reauth-2"),
        certusLinkStatus: "active",
        lastStatusSyncedAt: new Date(),
      },
    });
    const past = new Date(Date.now() - 60_000);
    const handle = await createReauthTransaction({
      userId: user.id,
      sessionId: "00000000-0000-0000-0000-00000000000a",
      action: "export",
      targetPath: "/settings/data",
      now: past,
    });
    expect(
      await verifyReauthTransaction({
        token: handle.token,
        sessionId: "00000000-0000-0000-0000-00000000000a",
        userId: user.id,
        action: "export",
        now: new Date(Date.now() + 5 * 60 * 1000 + 1000),
      }),
    ).toBe(false);

    const handle2 = await createReauthTransaction({
      userId: user.id,
      sessionId: "00000000-0000-0000-0000-00000000000a",
      action: "delete",
      targetPath: "/settings/data",
    });
    await terminateReauthTransaction(handle2.token);
    expect(
      await consumeReauthTransaction({
        token: handle2.token,
        sessionId: "00000000-0000-0000-0000-00000000000a",
        userId: user.id,
        action: "delete",
      }),
    ).toBe(false);

    await db.reauthTransaction.deleteMany({ where: { userId: user.id } });
    await db.user.delete({ where: { id: user.id } });
  });

  it("stores only SHA-256 of the token", async () => {
    const user = await db.user.create({
      data: {
        certusSub: uniqueSub("reauth-3"),
        certusLinkStatus: "active",
        lastStatusSyncedAt: new Date(),
      },
    });
    const handle = await createReauthTransaction({
      userId: user.id,
      sessionId: "00000000-0000-0000-0000-00000000000a",
      action: "export",
      targetPath: "/settings/data",
    });
    const row = await db.reauthTransaction.findUnique({
      where: { id: handle.transactionId },
    });
    expect(
      Buffer.from(row?.tokenHash ?? new Uint8Array()).toString("utf8"),
    ).not.toContain(handle.token);
    expect(Buffer.from(row?.tokenHash ?? new Uint8Array()).length).toBe(32);

    await db.reauthTransaction.deleteMany({ where: { userId: user.id } });
    await db.user.delete({ where: { id: user.id } });
  });
});
