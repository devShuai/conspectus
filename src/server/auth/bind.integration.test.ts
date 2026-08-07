import { describe, expect, it } from "vitest";

import { db } from "@/server/db";
import {
  bindCertusToUser,
  BindError,
  setLocalPassword,
  unbindCertusFromUser,
  unbindLocalPasswordFromUser,
} from "./bind";
import { hashPassword } from "./password";

const DISABLED = !process.env.TEST_DATABASE_URL;

function uniqueSub(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function uniqueEmail(): string {
  return `bind-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
}

describe.skipIf(DISABLED)("local/certus binding", () => {
  it("binds a certus sub to a local user and prevents double bind", async () => {
    const user = await db.user.create({
      data: {
        email: uniqueEmail(),
        passwordHash: await hashPassword("correct-horse-battery-9!"),
      },
    });
    const sub = uniqueSub("bind-target");
    await bindCertusToUser({
      userId: user.id,
      claims: { sub, name: "Alice" },
      config: {} as never,
    });

    const updated = await db.user.findUnique({ where: { id: user.id } });
    expect(updated?.certusSub).toBe(sub);
    expect(updated?.certusLinkStatus).toBe("active");

    await expect(
      bindCertusToUser({
        userId: user.id,
        claims: { sub: uniqueSub("bind-other") },
        config: {} as never,
      }),
    ).rejects.toMatchObject({ code: "already_bound" });

    await db.user.delete({ where: { id: user.id } });
  });

  it("rejects binding a sub that already belongs to another account", async () => {
    const sub = uniqueSub("bind-owned");
    await db.user.create({
      data: {
        certusSub: sub,
        certusLinkStatus: "active",
        lastStatusSyncedAt: new Date(),
      },
    });
    const local = await db.user.create({
      data: {
        email: uniqueEmail(),
        passwordHash: await hashPassword("correct-horse-battery-9!"),
      },
    });

    await expect(
      bindCertusToUser({
        userId: local.id,
        claims: { sub },
        config: {} as never,
      }),
    ).rejects.toMatchObject({ code: "sub_in_use" });

    await db.user.delete({ where: { id: local.id } });
    await db.user.delete({ where: { certusSub: sub } });
  });

  it("refuses to remove the last login method (409 semantics)", async () => {
    const localOnly = await db.user.create({
      data: {
        email: uniqueEmail(),
        passwordHash: await hashPassword("correct-horse-battery-9!"),
      },
    });
    await expect(unbindLocalPasswordFromUser(localOnly.id)).rejects.toMatchObject({
      code: "last_auth_method",
    });
    await expect(unbindCertusFromUser(localOnly.id)).rejects.toMatchObject({
      code: "invalid_input",
    });

    const certusOnly = await db.user.create({
      data: {
        certusSub: uniqueSub("bind-certus-only"),
        certusLinkStatus: "active",
        lastStatusSyncedAt: new Date(),
      },
    });
    await expect(unbindLocalPasswordFromUser(certusOnly.id)).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(unbindCertusFromUser(certusOnly.id)).rejects.toMatchObject({
      code: "last_auth_method",
    });

    await db.user.delete({ where: { id: localOnly.id } });
    await db.user.delete({ where: { id: certusOnly.id } });
  });

  it("unbinds certus but keeps local login working", async () => {
    const user = await db.user.create({
      data: {
        email: uniqueEmail(),
        passwordHash: await hashPassword("correct-horse-battery-9!"),
      },
    });
    const sub = uniqueSub("bind-unbind");
    await bindCertusToUser({
      userId: user.id,
      claims: { sub },
      config: {} as never,
    });
    await unbindCertusFromUser(user.id);
    const updated = await db.user.findUnique({ where: { id: user.id } });
    expect(updated?.certusSub).toBeNull();
    expect(updated?.passwordHash).not.toBeNull();

    await db.user.delete({ where: { id: user.id } });
  });

  it("sets a local password on a certus-only user (reverse bind)", async () => {
    const user = await db.user.create({
      data: {
        certusSub: uniqueSub("bind-reverse"),
        certusLinkStatus: "active",
        lastStatusSyncedAt: new Date(),
        email: uniqueEmail(),
      },
    });
    await setLocalPassword(user.id, "correct-horse-battery-9!");
    const updated = await db.user.findUnique({ where: { id: user.id } });
    expect(updated?.passwordHash).not.toBeNull();

    await db.user.delete({ where: { id: user.id } });
  });
});

void BindError;
