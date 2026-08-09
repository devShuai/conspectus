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


/**
 * #57：M6 邮件导入的保留清理（§5.4）——过期 pending ImportDraft 置 expired
 * （终态与未到期不动）；到达 rawRetainedUntil 的 InboundEmail.rawCipher 置空
 * （行保留，未到期不动）。
 */
describe.skipIf(DISABLED)("purge inbound/import retention (#57)", () => {
  const DAY = 86_400_000;

  function draftRow(userId: string, expiresAt: Date, status: "pending" | "accepted" = "pending") {
    return {
      userId,
      source: "email" as const,
      payload: {
        version: 1,
        candidate: { name: "x", amount: "1", currency: "CNY", billedAt: "2026-08-01" },
      },
      confidence: 0.8,
      status,
      expiresAt,
    };
  }

  it("expires overdue pending drafts only, never terminal or fresh ones", async () => {
    const user = await makeUser();
    const overduePending = await db.importDraft.create({
      data: draftRow(user.id, new Date(Date.now() - 60_000)),
    });
    const freshPending = await db.importDraft.create({
      data: draftRow(user.id, new Date(Date.now() + 7 * DAY)),
    });
    // 终态（accepted）即使超过 expiresAt 也不回改
    const overdueAccepted = await db.importDraft.create({
      data: draftRow(user.id, new Date(Date.now() - 60_000), "accepted"),
    });

    await runPurge();

    expect(
      (await db.importDraft.findUniqueOrThrow({ where: { id: overduePending.id } })).status,
    ).toBe("expired");
    expect(
      (await db.importDraft.findUniqueOrThrow({ where: { id: freshPending.id } })).status,
    ).toBe("pending");
    expect(
      (await db.importDraft.findUniqueOrThrow({ where: { id: overdueAccepted.id } })).status,
    ).toBe("accepted");

    // 幂等重跑：状态不再变化
    await runPurge();
    expect(
      (await db.importDraft.findUniqueOrThrow({ where: { id: freshPending.id } })).status,
    ).toBe("pending");

    await db.user.delete({ where: { id: user.id } });
  });

  it("keeps terminal drafts (rejected/expired) untouched even when overdue (#62)", async () => {
    const user = await makeUser();
    const past = new Date(Date.now() - 60_000);
    const rejected = await db.importDraft.create({
      data: { ...draftRow(user.id, past), status: "rejected" },
    });
    const expired = await db.importDraft.create({
      data: { ...draftRow(user.id, past), status: "expired" },
    });

    await runPurge();
    await runPurge(); // 幂等重跑：终态永不回改

    expect(
      (await db.importDraft.findUniqueOrThrow({ where: { id: rejected.id } })).status,
    ).toBe("rejected");
    expect(
      (await db.importDraft.findUniqueOrThrow({ where: { id: expired.id } })).status,
    ).toBe("expired");

    await db.user.delete({ where: { id: user.id } });
  });

  it("clears inbound rawCipher at rawRetainedUntil, keeps rows and fresh raw", async () => {    const user = await makeUser();
    const base = {
      userId: user.id,
      fromAddr: "billing@example.test",
      subject: "receipt",
      receivedAt: new Date(),
    };
    const due = await db.inboundEmail.create({
      data: {
        ...base,
        messageId: `<due-${randomUUID()}@e.test>`,
        rawCipher: randomBytes(16),
        rawRetainedUntil: new Date(Date.now() - 60_000),
      },
    });
    const fresh = await db.inboundEmail.create({
      data: {
        ...base,
        messageId: `<fresh-${randomUUID()}@e.test>`,
        rawCipher: randomBytes(16),
        rawRetainedUntil: new Date(Date.now() + 30 * DAY),
      },
    });
    // 用户关闭保留：始终无原文（purge 不应对它做任何事）
    const noRaw = await db.inboundEmail.create({
      data: {
        ...base,
        messageId: `<noraw-${randomUUID()}@e.test>`,
        rawCipher: null,
        rawRetainedUntil: null,
      },
    });

    await runPurge();

    const dueAfter = await db.inboundEmail.findUniqueOrThrow({ where: { id: due.id } });
    expect(dueAfter.rawCipher).toBeNull();
    // 行保留：元数据与期限记录不动
    expect(dueAfter.subject).toBe("receipt");
    expect(dueAfter.rawRetainedUntil).not.toBeNull();
    expect(
      (await db.inboundEmail.findUniqueOrThrow({ where: { id: fresh.id } })).rawCipher,
    ).not.toBeNull();
    expect(
      (await db.inboundEmail.findUniqueOrThrow({ where: { id: noRaw.id } })).rawCipher,
    ).toBeNull();

    // 幂等重跑（#62）：已置空的不重复处理，未到期原文不受影响
    await runPurge();
    expect(
      (await db.inboundEmail.findUniqueOrThrow({ where: { id: due.id } })).rawCipher,
    ).toBeNull();
    expect(
      (await db.inboundEmail.findUniqueOrThrow({ where: { id: fresh.id } })).rawCipher,
    ).not.toBeNull();

    await db.user.delete({ where: { id: user.id } });
  });
});
