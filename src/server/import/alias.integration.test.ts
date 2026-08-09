import { randomBytes, randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { db } from "@/server/db";

import {
  clearInboundRawNow,
  revokeInboundAlias,
  rotateInboundAlias,
  setInboundRawRetention,
} from "./alias";

/**
 * #58 别名生命周期（服务层）：生成/轮换/撤销/保留开关/立即清除，
 * 以及审计日志纪律（记事件与 userId，绝不记别名值）。
 */
const DISABLED = !process.env.TEST_DATABASE_URL;

async function makeUser() {
  return db.user.create({
    data: {
      email: `alias-${randomUUID()}@example.test`,
      passwordHash: "alias-test-not-a-real-hash",
    },
  });
}

describe.skipIf(DISABLED)("inbound alias lifecycle (#58)", () => {
  it("rotate generates, then replaces; the old alias stops resolving", async () => {
    const user = await makeUser();
    const first = await rotateInboundAlias(user.id);
    expect(first).toMatch(/^u-[a-z2-7]{26}$/);
    expect(
      (await db.user.findUniqueOrThrow({ where: { id: user.id } })).inboundAddress,
    ).toBe(first);

    const second = await rotateInboundAlias(user.id);
    expect(second).not.toBe(first);
    expect(await db.user.findUnique({ where: { inboundAddress: first } })).toBeNull();
    expect((await db.user.findUnique({ where: { inboundAddress: second } }))?.id).toBe(user.id);

    await db.user.delete({ where: { id: user.id } });
  });

  it("revoke clears the alias; retention toggle flips the flag", async () => {
    const user = await makeUser();
    const alias = await rotateInboundAlias(user.id);
    await revokeInboundAlias(user.id);

    const after = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.inboundAddress).toBeNull();
    expect(await db.user.findUnique({ where: { inboundAddress: alias } })).toBeNull();

    await setInboundRawRetention(user.id, false);
    expect(
      (await db.user.findUniqueOrThrow({ where: { id: user.id } })).inboundRetainRaw,
    ).toBe(false);
    await setInboundRawRetention(user.id, true);
    expect(
      (await db.user.findUniqueOrThrow({ where: { id: user.id } })).inboundRetainRaw,
    ).toBe(true);

    await db.user.delete({ where: { id: user.id } });
  });

  it("clearInboundRawNow clears only this user's raw, rows kept", async () => {
    const owner = await makeUser();
    const other = await makeUser();
    const row = (userId: string) => ({
      userId,
      messageId: `<clr-${randomUUID()}@e.test>`,
      fromAddr: "a@b.c",
      subject: "s",
      receivedAt: new Date(),
      rawCipher: randomBytes(16),
      rawRetainedUntil: new Date(Date.now() + 86_400_000),
    });
    const mine = await db.inboundEmail.create({ data: row(owner.id) });
    const theirs = await db.inboundEmail.create({ data: row(other.id) });

    const cleared = await clearInboundRawNow(owner.id);
    expect(cleared).toBe(1);

    const mineAfter = await db.inboundEmail.findUniqueOrThrow({ where: { id: mine.id } });
    expect(mineAfter.rawCipher).toBeNull();
    expect(mineAfter.subject).toBe("s"); // 行与元数据保留
    expect(
      (await db.inboundEmail.findUniqueOrThrow({ where: { id: theirs.id } })).rawCipher,
    ).not.toBeNull();

    // 幂等：再清一次为 0
    expect(await clearInboundRawNow(owner.id)).toBe(0);

    await db.user.delete({ where: { id: owner.id } });
    await db.user.delete({ where: { id: other.id } });
  });

  it("audit log records the event and userId, never the alias value", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const user = await makeUser();
    const alias = await rotateInboundAlias(user.id);
    await revokeInboundAlias(user.id);

    const records = spy.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.includes("inbound_alias"));
    expect(records.length).toBe(2);
    for (const line of records) {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      expect(parsed.userId).toBe(user.id);
      expect(line).not.toContain(alias);
    }

    await db.user.delete({ where: { id: user.id } });
  });
});
