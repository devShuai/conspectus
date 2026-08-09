import { randomBytes, randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { db } from "@/server/db";

import { runPurge } from "./purge";

/**
 * #121-5：purge 补齐的 4 类保留清理（§5.4）——过期 PasswordResetToken、
 * 超 10 分钟保留期的 CollectorNonce、终态超 90 天的 NotificationDelivery
 * 与 NotificationDigest。断言只用本测试自建 user 维度，不断言全局计数。
 */
const DISABLED = !process.env.TEST_DATABASE_URL;

const DAY_MS = 86_400_000;

async function makeUser() {
  // users_login_method / users_local_email_required CHECK：本地账号必须带邮箱
  return db.user.create({
    data: {
      email: `purge-${randomUUID()}@example.test`,
      passwordHash: "purge-test-not-a-real-hash",
    },
  });
}

describe.skipIf(DISABLED)("purge retention additions (#121)", () => {
  it("purges expired PasswordResetToken and keeps fresh ones", async () => {
    const user = await makeUser();
    const expired = await db.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: randomBytes(32),
        expiresAt: new Date(Date.now() - 60_000),
      },
    });
    const fresh = await db.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: randomBytes(32),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    await runPurge();

    expect(await db.passwordResetToken.findUnique({ where: { id: expired.id } })).toBeNull();
    expect(await db.passwordResetToken.findUnique({ where: { id: fresh.id } })).not.toBeNull();
    await db.user.delete({ where: { id: user.id } });
  });

  it("purges CollectorNonce beyond the 10-minute retention and keeps recent ones", async () => {
    const deviceId = randomUUID();
    const old = await db.collectorNonce.create({
      data: { deviceId, nonce: `old-${randomUUID()}`, seenAt: new Date(Date.now() - 11 * 60_000) },
    });
    const fresh = await db.collectorNonce.create({
      data: { deviceId, nonce: `fresh-${randomUUID()}`, seenAt: new Date() },
    });

    await runPurge();

    const remaining = await db.collectorNonce.findMany({ where: { deviceId } });
    expect(remaining.map((n) => n.nonce)).toEqual([fresh.nonce]);
    expect(
      await db.collectorNonce.findUnique({
        where: { deviceId_nonce: { deviceId, nonce: old.nonce } },
      }),
    ).toBeNull();
    await db.collectorNonce.deleteMany({ where: { deviceId } });
  });

  it("purges terminal NotificationDelivery/Digest older than 90 days only", async () => {
    const user = await makeUser();
    const channel = await db.notificationChannel.create({
      data: { userId: user.id, type: "email", destination: "purge@example.test" },
    });
    const rule = await db.notificationRule.create({
      data: { userId: user.id, type: "renewal_due", config: {} },
    });
    // Delivery 有 (eventId, channelId) 唯一约束：每条 Delivery 配独立 Event
    const makeEvent = () =>
      db.notificationEvent.create({
        data: {
          userId: user.id,
          ruleId: rule.id,
          subjectType: "subscription",
          subjectId: randomUUID(),
          dedupeKey: `purge-${randomUUID()}`,
          payload: {},
          occurredAt: new Date(),
        },
      });

    const oldDate = new Date(Date.now() - 100 * DAY_MS);
    const recentDate = new Date(Date.now() - 10 * DAY_MS);

    // 终态 >90 天 → 清
    const oldSent = await db.notificationDelivery.create({
      data: {
        userId: user.id,
        eventId: (await makeEvent()).id,
        channelId: channel.id,
        scheduledAt: oldDate,
        status: "sent",
        sentAt: oldDate,
        updatedAt: oldDate,
      },
    });
    // 终态但未到期 → 留
    const recentSent = await db.notificationDelivery.create({
      data: {
        userId: user.id,
        eventId: (await makeEvent()).id,
        channelId: channel.id,
        scheduledAt: recentDate,
        status: "sent",
        sentAt: recentDate,
        updatedAt: recentDate,
      },
    });
    // >90 天但非终态（可恢复延迟不算终态）→ 留
    const oldPending = await db.notificationDelivery.create({
      data: {
        userId: user.id,
        eventId: (await makeEvent()).id,
        channelId: channel.id,
        scheduledAt: oldDate,
        status: "pending",
        updatedAt: oldDate,
      },
    });

    // 终态 >90 天、无 Delivery 引用 → 清
    const oldDigest = await db.notificationDigest.create({
      data: {
        userId: user.id,
        channelId: channel.id,
        localDate: new Date("2026-04-01T00:00:00Z"),
        scheduledAt: oldDate,
        status: "sent",
        sentAt: oldDate,
        updatedAt: oldDate,
      },
    });
    // 终态 >90 天但仍被未到期 Delivery 引用 → 留（外键底线）
    const referencedDigest = await db.notificationDigest.create({
      data: {
        userId: user.id,
        channelId: channel.id,
        localDate: new Date("2026-04-02T00:00:00Z"),
        scheduledAt: oldDate,
        status: "failed",
        updatedAt: oldDate,
      },
    });
    await db.notificationDelivery.update({
      where: { id: recentSent.id },
      data: { digestId: referencedDigest.id },
    });

    await runPurge();

    expect(await db.notificationDelivery.findUnique({ where: { id: oldSent.id } })).toBeNull();
    expect(
      await db.notificationDelivery.findUnique({ where: { id: recentSent.id } }),
    ).not.toBeNull();
    expect(
      await db.notificationDelivery.findUnique({ where: { id: oldPending.id } }),
    ).not.toBeNull();
    expect(await db.notificationDigest.findUnique({ where: { id: oldDigest.id } })).toBeNull();
    expect(
      await db.notificationDigest.findUnique({ where: { id: referencedDigest.id } }),
    ).not.toBeNull();

    // 幂等重跑：第二次不再删任何本用例行
    const second = await runPurge();
    expect(
      await db.notificationDelivery.findUnique({ where: { id: recentSent.id } }),
    ).not.toBeNull();
    void second;

    await db.notificationDelivery.deleteMany({ where: { userId: user.id } });
    await db.notificationDigest.deleteMany({ where: { userId: user.id } });
    await db.notificationEvent.deleteMany({ where: { userId: user.id } });
    await db.notificationRule.deleteMany({ where: { userId: user.id } });
    await db.notificationChannel.deleteMany({ where: { userId: user.id } });
    await db.user.delete({ where: { id: user.id } });
  });
});
