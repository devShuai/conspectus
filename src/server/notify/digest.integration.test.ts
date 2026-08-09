import { beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "@/server/db";
import { localToday } from "@/server/billing/local-date";

import { emitEvent } from "./scan";
import { dispatchDueDeliveries } from "./dispatch";
import { dispatchDueDigests, DIGEST_RETRY_MS } from "./digest";

const { sendEmailMock, fetchUserStatusMock } = vi.hoisted(() => ({
  sendEmailMock: vi.fn(),
  fetchUserStatusMock: vi.fn(),
}));

vi.mock("@/server/auth/email-sender", () => ({
  sendEmail: sendEmailMock,
}));

vi.mock("@/server/auth/certus-client-api", () => ({
  fetchUserStatus: fetchUserStatusMock,
}));

const DISABLED = !process.env.TEST_DATABASE_URL;

function uniqueSub(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function setupUser(opts: { emailVerified?: boolean; certusSourced?: boolean } = {}) {
  const source = opts.certusSourced ? "certus" : "local";
  return db.user.create({
    data: {
      certusSub: uniqueSub("digest91"),
      certusLinkStatus: "active",
      lastStatusSyncedAt: new Date(),
      timezone: "Asia/Shanghai",
      email: `d91-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
      emailVerifiedAt: opts.emailVerified === false ? null : new Date(),
      emailVerificationSource: opts.emailVerified === false ? null : source,
    },
  });
}

async function setupDigestChannel(userId: string) {
  return db.notificationChannel.create({
    data: { userId, type: "email", mode: "daily_digest" },
  });
}

async function setupRule(userId: string) {
  return db.notificationRule.create({
    data: { userId, type: "renewal_due", config: { daysBefore: [7] } },
  });
}

async function emit(userId: string, ruleId: string, key: string) {
  const result = await emitEvent({
    userId,
    ruleId,
    subjectType: "subscription",
    subjectId: "00000000-0000-0000-0000-000000000091",
    dedupeKey: key,
    payload: { name: "digest-fixture" },
  });
  expect(result).not.toBeNull();
  return result!;
}

/** 批次拨到到期，模拟「下一个本地 09:00 已到」。 */
async function makeDue(digestId: string) {
  await db.notificationDigest.update({
    where: { id: digestId },
    data: { scheduledAt: new Date(Date.now() - 60_000) },
  });
}

describe.skipIf(DISABLED)("daily_digest pipeline (#91)", () => {
  beforeEach(() => {
    sendEmailMock.mockReset();
    sendEmailMock.mockResolvedValue(undefined);
  });

  it("emitEvent upserts the (channelId, localDate) batch and links deliveries to it", async () => {
    const user = await setupUser();
    const rule = await setupRule(user.id);
    const channel = await setupDigestChannel(user.id);
    const before = new Date();

    const first = await emit(user.id, rule.id, `d91-a-${Date.now()}`);
    const digest = await db.notificationDigest.findFirstOrThrow({
      where: { channelId: channel.id },
    });
    // 批次排程严格晚于入队时刻的下一个本地 09:00（§7.6）
    expect(digest.status).toBe("pending");
    expect(digest.scheduledAt.getTime()).toBeGreaterThan(before.getTime());
    expect(digest.localDate.getTime()).toBe(
      localToday(digest.scheduledAt, "Asia/Shanghai").getTime(),
    );

    const delivery = await db.notificationDelivery.findFirstOrThrow({
      where: { eventId: first.eventId, channelId: channel.id },
    });
    expect(delivery.digestId).toBe(digest.id);
    expect(delivery.scheduledAt.getTime()).toBe(digest.scheduledAt.getTime());

    // 同一摘要日的第二个事件并入同一批次（upsert 不建行）
    const second = await emit(user.id, rule.id, `d91-b-${Date.now()}`);
    expect(
      await db.notificationDigest.count({ where: { channelId: channel.id } }),
    ).toBe(1);
    const secondDelivery = await db.notificationDelivery.findFirstOrThrow({
      where: { eventId: second.eventId, channelId: channel.id },
    });
    expect(secondDelivery.digestId).toBe(digest.id);

    await db.user.delete({ where: { id: user.id } });
  });

  it("a terminal batch rejects late events: they roll into the next local date", async () => {
    const user = await setupUser();
    const rule = await setupRule(user.id);
    const channel = await setupDigestChannel(user.id);

    const first = await emit(user.id, rule.id, `d91-c-${Date.now()}`);
    const firstDigest = await db.notificationDigest.findFirstOrThrow({
      where: { channelId: channel.id },
    });
    // 批次已发送（终态）后，迟到事件不得再挂进去（§7.6）
    await db.notificationDigest.update({
      where: { id: firstDigest.id },
      data: { status: "sent", sentAt: new Date() },
    });

    const second = await emit(user.id, rule.id, `d91-d-${Date.now()}`);
    const digests = await db.notificationDigest.findMany({
      where: { channelId: channel.id },
      orderBy: { localDate: "asc" },
    });
    expect(digests.length).toBe(2);
    const late = await db.notificationDelivery.findFirstOrThrow({
      where: { eventId: second.eventId, channelId: channel.id },
    });
    expect(late.digestId).not.toBe(firstDigest.id);
    expect(late.digestId).toBe(digests[1].id);
    expect(digests[1].status).toBe("pending");
    expect(digests[1].localDate.getTime()).toBeGreaterThan(
      digests[0].localDate.getTime(),
    );

    await db.user.delete({ where: { id: user.id } });
  });

  it("direct dispatcher never leases digest children (digestId IS NULL filter)", async () => {
    const user = await setupUser();
    const rule = await setupRule(user.id);
    const channel = await setupDigestChannel(user.id);
    const event = await emit(user.id, rule.id, `d91-e-${Date.now()}`);
    const delivery = await db.notificationDelivery.findFirstOrThrow({
      where: { eventId: event.eventId, channelId: channel.id },
    });
    // 拨到过去也不许被 direct 租走 —— 摘要子项只能由其 Digest 批次消费
    await db.notificationDelivery.update({
      where: { id: delivery.id },
      data: { scheduledAt: new Date(Date.now() - 3_600_000) },
    });

    await dispatchDueDeliveries(new Date());
    const after = await db.notificationDelivery.findUniqueOrThrow({
      where: { id: delivery.id },
    });
    expect(after.status).toBe("pending");
    expect(after.digestId).not.toBeNull();
    expect(sendEmailMock).not.toHaveBeenCalled();

    await db.user.delete({ where: { id: user.id } });
  });

  it("digest worker sends the batch and marks digest + children sent", async () => {
    const user = await setupUser();
    const rule = await setupRule(user.id);
    const channel = await setupDigestChannel(user.id);
    const event = await emit(user.id, rule.id, `d91-f-${Date.now()}`);
    const digest = await db.notificationDigest.findFirstOrThrow({
      where: { channelId: channel.id },
    });
    await makeDue(digest.id);

    await dispatchDueDigests(new Date());

    const after = await db.notificationDigest.findUniqueOrThrow({
      where: { id: digest.id },
    });
    expect(after.status).toBe("sent");
    expect(after.sentAt).not.toBeNull();
    const child = await db.notificationDelivery.findFirstOrThrow({
      where: { eventId: event.eventId, channelId: channel.id },
    });
    expect(child.status).toBe("sent");
    expect(child.sentAt).not.toBeNull();
    expect(sendEmailMock).toHaveBeenCalled();
    expect(sendEmailMock.mock.calls[0]?.[0]).toMatchObject({ to: user.email });

    await db.user.delete({ where: { id: user.id } });
  });

  it("known-unverified email blocks digest and children (terminal, not failed)", async () => {
    const user = await setupUser({ emailVerified: false });
    const rule = await setupRule(user.id);
    const channel = await setupDigestChannel(user.id);
    const event = await emit(user.id, rule.id, `d91-g-${Date.now()}`);
    const digest = await db.notificationDigest.findFirstOrThrow({
      where: { channelId: channel.id },
    });
    await makeDue(digest.id);

    await dispatchDueDigests(new Date());

    const after = await db.notificationDigest.findUniqueOrThrow({
      where: { id: digest.id },
    });
    expect(after.status).toBe("blocked"); // #91：原来是 failed
    const child = await db.notificationDelivery.findFirstOrThrow({
      where: { eventId: event.eventId, channelId: channel.id },
    });
    expect(child.status).toBe("blocked");
    expect(sendEmailMock).not.toHaveBeenCalled();

    await db.user.delete({ where: { id: user.id } });
  });

  // #125：可恢复的邮箱门禁现在来自逐批复核 —— certus 没给出地址就无法成对校验
  it("an unpairable certus response defers the batch without burning attempts", async () => {
    const user = await setupUser({ certusSourced: true });
    fetchUserStatusMock.mockResolvedValue({
      httpStatus: 200,
      status: "active",
      active: true,
      emailVerified: true, // 有验证位但没有地址：不可采信
      hasUpdatedAt: false,
      notFoundOpaque: false,
      leakedProfileFields: [],
    });
    const rule = await setupRule(user.id);
    const channel = await setupDigestChannel(user.id);
    const event = await emit(user.id, rule.id, `d91-h-${Date.now()}`);
    const digest = await db.notificationDigest.findFirstOrThrow({
      where: { channelId: channel.id },
    });
    await makeDue(digest.id);

    const now = new Date();
    await dispatchDueDigests(now);

    const after = await db.notificationDigest.findUniqueOrThrow({
      where: { id: digest.id },
    });
    expect(after.status).toBe("pending");
    expect(after.attempts).toBe(0);
    expect(after.deferredReason).toBe("identity_email_unavailable"); // 结构化门禁原因
    expect(after.nextAttemptAt).not.toBeNull();
    expect(after.nextAttemptAt!.getTime()).toBeGreaterThan(now.getTime());
    const child = await db.notificationDelivery.findFirstOrThrow({
      where: { eventId: event.eventId, channelId: channel.id },
    });
    expect(child.status).toBe("pending");
    expect(sendEmailMock).not.toHaveBeenCalled();

    await db.user.delete({ where: { id: user.id } });
  });

  it("send failure retries on the ladder, then fails digest + children together", async () => {
    const user = await setupUser();
    const rule = await setupRule(user.id);
    const channel = await setupDigestChannel(user.id);
    const event = await emit(user.id, rule.id, `d91-i-${Date.now()}`);
    const digest = await db.notificationDigest.findFirstOrThrow({
      where: { channelId: channel.id },
    });
    await makeDue(digest.id);
    sendEmailMock.mockRejectedValue(new Error("resend down"));

    const t0 = new Date();
    await dispatchDueDigests(t0);
    let d = await db.notificationDigest.findUniqueOrThrow({ where: { id: digest.id } });
    expect(d.status).toBe("pending");
    expect(d.attempts).toBe(1);
    expect(d.nextAttemptAt!.getTime()).toBeGreaterThanOrEqual(
      t0.getTime() + DIGEST_RETRY_MS[0],
    );

    // 直接推进到第 MAX 次外呼：终态 failed，子 Delivery 同事务一并 failed
    await db.notificationDigest.update({
      where: { id: digest.id },
      data: { attempts: 3, nextAttemptAt: null },
    });
    await dispatchDueDigests(new Date());
    d = await db.notificationDigest.findUniqueOrThrow({ where: { id: digest.id } });
    expect(d.status).toBe("failed");
    const child = await db.notificationDelivery.findFirstOrThrow({
      where: { eventId: event.eventId, channelId: channel.id },
    });
    expect(child.status).toBe("failed");

    await db.user.delete({ where: { id: user.id } });
  });

  it("disabled channel cancels the batch and its children; empty batch cancels too", async () => {
    const user = await setupUser();
    const rule = await setupRule(user.id);
    const channel = await setupDigestChannel(user.id);
    const event = await emit(user.id, rule.id, `d91-j-${Date.now()}`);
    const digest = await db.notificationDigest.findFirstOrThrow({
      where: { channelId: channel.id },
    });
    await makeDue(digest.id);
    await db.notificationChannel.update({
      where: { id: channel.id },
      data: { enabled: false },
    });

    await dispatchDueDigests(new Date());
    const after = await db.notificationDigest.findUniqueOrThrow({
      where: { id: digest.id },
    });
    expect(after.status).toBe("canceled");
    const child = await db.notificationDelivery.findFirstOrThrow({
      where: { eventId: event.eventId, channelId: channel.id },
    });
    expect(child.status).toBe("canceled");

    // 空批次（无有效条目）→ canceled
    const empty = await db.notificationDigest.create({
      data: {
        userId: user.id,
        channelId: channel.id,
        localDate: new Date("2020-01-01T00:00:00Z"),
        scheduledAt: new Date(Date.now() - 60_000),
      },
    });
    await dispatchDueDigests(new Date());
    const emptyAfter = await db.notificationDigest.findUniqueOrThrow({
      where: { id: empty.id },
    });
    expect(emptyAfter.status).toBe("canceled");

    await db.user.delete({ where: { id: user.id } });
  });
});
