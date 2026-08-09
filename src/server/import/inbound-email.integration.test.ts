import { randomBytes, randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { db } from "@/server/db";
import { dashboardStats } from "@/server/billing/stats";

/**
 * #57 schema 验收：InboundEmail/ImportDraft 的幂等、租户与统计隔离。
 * 断言只用本测试自建 user 维度，不断言全局计数。
 */
const DISABLED = !process.env.TEST_DATABASE_URL;

async function makeUser() {
  // users_login_method / users_local_email_required CHECK：本地账号必须带邮箱
  return db.user.create({
    data: {
      email: `m6-${randomUUID()}@example.test`,
      passwordHash: "m6-test-not-a-real-hash",
    },
  });
}

function mailRow(userId: string, messageId: string) {
  return {
    userId,
    messageId,
    fromAddr: "billing@example.test",
    subject: "receipt",
    receivedAt: new Date(),
    rawCipher: randomBytes(16),
    rawRetainedUntil: new Date(Date.now() + 30 * 86_400_000),
  };
}

describe.skipIf(DISABLED)("InboundEmail / ImportDraft schema (#57)", () => {
  it("相同用户/messageId 并发只入站一次", async () => {
    const user = await makeUser();
    const messageId = `<dup-${randomUUID()}@example.test>`;

    const [a, b] = await Promise.allSettled([
      db.inboundEmail.create({ data: mailRow(user.id, messageId) }),
      db.inboundEmail.create({ data: mailRow(user.id, messageId) }),
    ]);
    const fulfilled = [a, b].filter((r) => r.status === "fulfilled");

    expect(fulfilled).toHaveLength(1);
    expect(
      await db.inboundEmail.count({ where: { userId: user.id, messageId } }),
    ).toBe(1);

    await db.user.delete({ where: { id: user.id } });
  });

  it("不同用户可持有相同 messageId（唯一约束按用户维度）", async () => {
    const [u1, u2] = await Promise.all([makeUser(), makeUser()]);
    const messageId = `<shared-${randomUUID()}@example.test>`;

    await db.inboundEmail.create({ data: mailRow(u1.id, messageId) });
    await db.inboundEmail.create({ data: mailRow(u2.id, messageId) });

    expect(await db.inboundEmail.count({ where: { messageId } })).toBe(2);

    await db.user.delete({ where: { id: u1.id } });
    await db.user.delete({ where: { id: u2.id } });
  });

  it("rawCipher 非空时缺 rawRetainedUntil 被 CHECK 拒绝", async () => {
    const user = await makeUser();
    await expect(
      db.inboundEmail.create({
        data: { ...mailRow(user.id, `<chk-${randomUUID()}@e.test>`), rawRetainedUntil: null },
      }),
    ).rejects.toThrow();
    await db.user.delete({ where: { id: user.id } });
  });

  it("未确认 Draft 不出现在 BillingRecord 与实付统计", async () => {
    const user = await makeUser();
    await db.importDraft.create({
      data: {
        userId: user.id,
        source: "email",
        payload: {
          version: 1,
          candidate: {
            name: "Netflix",
            amount: "68.00",
            currency: "CNY",
            billedAt: "2026-08-01",
          },
        },
        confidence: 0.95,
        expiresAt: new Date(Date.now() + 7 * 86_400_000),
      },
    });

    expect(await db.billingRecord.count({ where: { userId: user.id } })).toBe(0);
    const stats = await dashboardStats(user.id);
    expect(stats.monthCharges).toBe(0);
    expect(stats.monthRefunds).toBe(0);
    expect(stats.monthNetSpend).toBe(0);

    await db.user.delete({ where: { id: user.id } });
  });

  it("跨用户的 suggestedSubscriptionId 被租户触发器拒绝", async () => {
    const owner = await makeUser();
    const other = await makeUser();
    const foreignSub = await db.subscription.create({
      data: {
        userId: other.id,
        name: "foreign",
        status: "active",
        price: "10.00",
        currency: "CNY",
        billingCycle: "monthly",
        startedAt: new Date("2026-01-01"),
      },
    });

    await expect(
      db.importDraft.create({
        data: {
          userId: owner.id,
          source: "email",
          payload: { version: 1, candidate: { name: "x", amount: "1", currency: "CNY", billedAt: "2026-08-01" } },
          confidence: 0.5,
          suggestedSubscriptionId: foreignSub.id,
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      }),
    ).rejects.toThrow(/same user/);

    await db.user.delete({ where: { id: owner.id } });
    await db.user.delete({ where: { id: other.id } });
  });

  it("confidence 超出 0..1 被 CHECK 拒绝", async () => {
    const user = await makeUser();
    await expect(
      db.importDraft.create({
        data: {
          userId: user.id,
          source: "csv",
          payload: { version: 1, candidate: { name: "x", amount: "1", currency: "CNY", billedAt: "2026-08-01" } },
          confidence: 1.5,
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      }),
    ).rejects.toThrow();
    await db.user.delete({ where: { id: user.id } });
  });
});
