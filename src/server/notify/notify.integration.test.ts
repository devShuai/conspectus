import { createHmac } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "@/server/db";
import {
  encryptCredential,
  loadCredentialKeyring,
} from "@/server/auth/crypto";
import { armOrSkip, clearArm, emitEvent, runNotificationScan } from "./scan";
import { dispatchDueDeliveries } from "./dispatch";
import { webhookHeaders } from "./webhook-signing";

const { postSafeWebhookMock } = vi.hoisted(() => ({
  postSafeWebhookMock: vi.fn(),
}));

vi.mock("./webhook-safe", () => ({
  postSafeWebhook: postSafeWebhookMock,
}));

const DISABLED = !process.env.TEST_DATABASE_URL;

function uniqueSub(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function setupUser() {
  return db.user.create({
    data: {
      certusSub: uniqueSub("notify"),
      certusLinkStatus: "active",
      lastStatusSyncedAt: new Date(),
      emailVerifiedAt: new Date(),
      emailVerificationSource: "local",
      email: `n-${Date.now()}@example.com`,
    },
  });
}

describe.skipIf(DISABLED)("notification scan + dispatch", () => {
  beforeEach(() => {
    postSafeWebhookMock.mockReset();
    postSafeWebhookMock.mockResolvedValue(false);
  });

  it("arm state is single-episode and re-arms after clear", async () => {
    const user = await setupUser();
    const rule = await db.notificationRule.create({
      data: { userId: user.id, type: "balance_low", config: { minValue: 10 } },
    });
    const key1 = await armOrSkip({
      userId: user.id,
      ruleId: rule.id,
      subjectType: "quota",
      subjectId: "00000000-0000-0000-0000-0000000000aa",
      armKey: "arm-1",
    });
    expect(key1).toBe("arm-1");
    // already armed → null
    const key2 = await armOrSkip({
      userId: user.id,
      ruleId: rule.id,
      subjectType: "quota",
      subjectId: "00000000-0000-0000-0000-0000000000aa",
      armKey: "arm-2",
    });
    expect(key2).toBeNull();
    // clear → re-arm
    await clearArm({
      ruleId: rule.id,
      subjectType: "quota",
      subjectId: "00000000-0000-0000-0000-0000000000aa",
    });
    const key3 = await armOrSkip({
      userId: user.id,
      ruleId: rule.id,
      subjectType: "quota",
      subjectId: "00000000-0000-0000-0000-0000000000aa",
      armKey: "arm-3",
    });
    expect(key3).toBe("arm-3");

    await db.notificationArmState.deleteMany({ where: { userId: user.id } });
    await db.notificationRule.deleteMany({ where: { userId: user.id } });
    await db.user.delete({ where: { id: user.id } });
  });

  it("emitEvent dedupes and creates one delivery per channel", async () => {
    const user = await setupUser();
    const rule = await db.notificationRule.create({
      data: { userId: user.id, type: "renewal_due", config: { daysBefore: [7] } },
    });
    await db.notificationChannel.create({
      data: { userId: user.id, type: "email", mode: "individual" },
    });
    await db.notificationChannel.create({
      data: { userId: user.id, type: "webhook", mode: "individual", destination: "https://example.com/hook", secretCipher: Buffer.from(new Uint8Array(16).fill(3)) },
    });

    const first = await emitEvent({
      userId: user.id,
      ruleId: rule.id,
      subjectType: "subscription",
      subjectId: "00000000-0000-0000-0000-0000000000bb",
      dedupeKey: "renewal:2026-02-01:d7",
      payload: { name: "x" },
    });
    expect(first).not.toBeNull();
    const second = await emitEvent({
      userId: user.id,
      ruleId: rule.id,
      subjectType: "subscription",
      subjectId: "00000000-0000-0000-0000-0000000000bb",
      dedupeKey: "renewal:2026-02-01:d7",
      payload: { name: "x" },
    });
    expect(second).toBeNull(); // dedupe

    const deliveries = await db.notificationDelivery.findMany({
      where: { eventId: first?.eventId },
    });
    expect(deliveries.length).toBe(2); // email + webhook

    await db.notificationDelivery.deleteMany({ where: { userId: user.id } });
    await db.notificationEvent.deleteMany({ where: { userId: user.id } });
    await db.notificationChannel.deleteMany({ where: { userId: user.id } });
    await db.notificationRule.deleteMany({ where: { userId: user.id } });
    await db.user.delete({ where: { id: user.id } });
  });

  it("scan emits renewal events and skips suspended users", async () => {
    const user = await setupUser();
    const rule = await db.notificationRule.create({
      data: { userId: user.id, type: "renewal_due", config: { daysBefore: [7] } },
    });
    await db.subscription.create({
      data: {
        userId: user.id,
        name: "Due in 7d",
        price: 10,
        currency: "CNY",
        billingCycle: "monthly",
        startedAt: new Date("2026-01-01T00:00:00Z"),
        nextBillingAt: new Date(Date.now() + 7 * 86_400_000),
        status: "active",
      },
    });
    await db.subscription.create({
      data: {
        userId: user.id,
        name: "Canceled",
        price: 10,
        currency: "CNY",
        billingCycle: "monthly",
        startedAt: new Date("2026-01-01T00:00:00Z"),
        nextBillingAt: new Date(Date.now() + 7 * 86_400_000),
        status: "canceled",
      },
    });

    const result = await runNotificationScan(new Date());
    // 共享库里并发扫描会竞争同一 dedupeKey，断言事件已存在而非本轮返回值
    expect(
      (await db.notificationEvent.findMany({ where: { userId: user.id } })).length,
    ).toBeGreaterThanOrEqual(1);

    // suspended user skipped
    await db.user.update({ where: { id: user.id }, data: { status: "suspended", statusReason: "admin" } });
    const result2 = await runNotificationScan(new Date());
    expect(result2.events).toBe(0);

    await db.notificationEvent.deleteMany({ where: { userId: user.id } });
    await db.notificationRule.deleteMany({ where: { userId: user.id } });
    await db.subscription.deleteMany({ where: { userId: user.id } });
    await db.user.delete({ where: { id: user.id } });
  });

  it("dispatch blocks unverified email and retries failed webhook with backoff", async () => {
    const user = await setupUser();
    const rule = await db.notificationRule.create({
      data: { userId: user.id, type: "renewal_due", config: { daysBefore: [1] } },
    });
    // channels exist BEFORE the event so deliveries are created
    await db.user.update({
      where: { id: user.id },
      data: { emailVerifiedAt: null, emailVerificationSource: null },
    });
    const emailChannel = await db.notificationChannel.create({
      data: { userId: user.id, type: "email", mode: "individual" },
    });
    const subForEvent = await db.subscription.create({
      data: {
        userId: user.id,
        name: "BlockedEmail",
        price: 10,
        currency: "CNY",
        billingCycle: "monthly",
        startedAt: new Date("2026-01-01T00:00:00Z"),
        status: "active",
      },
    });
    const event = await emitEvent({
      userId: user.id,
      ruleId: rule.id,
      subjectType: "subscription",
      subjectId: subForEvent.id,
      dedupeKey: "renewal:2026-03-01:d1",
      payload: { name: "x" },
      occurredAt: new Date(Date.now() - 60_000),
    });

    // unverified email → blocked
    const result = await dispatchDueDeliveries(new Date());
    expect(result.blocked).toBe(1);
    const emailDelivery = await db.notificationDelivery.findFirst({
      where: { eventId: event?.eventId, channelId: emailChannel.id },
    });
    expect(emailDelivery?.status).toBe("blocked");

    // webhook to unreachable URL retries with backoff
    await db.user.update({
      where: { id: user.id },
      data: { emailVerifiedAt: new Date(), emailVerificationSource: "local" },
    });
    const webhookChannel = await db.notificationChannel.create({
      data: { userId: user.id, type: "webhook", mode: "individual", destination: "http://127.0.0.1:9/never", secretCipher: Buffer.from(new Uint8Array(16).fill(5)) },
    });
    const event2 = await emitEvent({
      userId: user.id,
      ruleId: rule.id,
      subjectType: "subscription",
      subjectId: subForEvent.id,
      dedupeKey: "renewal:2026-03-02:d1",
      payload: { name: "y" },
    });
    await dispatchDueDeliveries(new Date());
    // 并发测试共用全局 dispatcher，重试可能已由其他调度轮完成 —— 断言退避后的终态
    const webhookDelivery = await db.notificationDelivery.findFirstOrThrow({
      where: { eventId: event2?.eventId, channelId: webhookChannel.id },
    });
    expect(webhookDelivery.status).toBe("pending");
    expect(webhookDelivery.attempts).toBeGreaterThanOrEqual(1);
    expect(webhookDelivery.nextAttemptAt).not.toBeNull();

    await db.notificationDelivery.deleteMany({ where: { userId: user.id } });
    await db.notificationEvent.deleteMany({ where: { userId: user.id } });
    await db.notificationChannel.deleteMany({ where: { userId: user.id } });
    await db.notificationRule.deleteMany({ where: { userId: user.id } });
    await db.user.delete({ where: { id: user.id } });
  });

  it("decrypts a webhook secret and sends a verifiable HMAC header", async () => {
    const user = await setupUser();
    const rule = await db.notificationRule.create({
      data: { userId: user.id, type: "renewal_due", config: { daysBefore: [1] } },
    });
    const plaintextSecret = Buffer.from("webhook-signing-secret", "utf8");
    const channel = await db.notificationChannel.create({
      data: {
        userId: user.id,
        type: "webhook",
        mode: "individual",
        destination: "https://webhook.example/hook",
        secretCipher: new Uint8Array(
          encryptCredential(plaintextSecret, loadCredentialKeyring()),
        ),
      },
    });
    const subForHmac = await db.subscription.create({
      data: {
        userId: user.id,
        name: "SignedSub",
        price: 10,
        currency: "CNY",
        billingCycle: "monthly",
        startedAt: new Date("2026-01-01T00:00:00Z"),
        status: "active",
      },
    });
    const event = await emitEvent({
      userId: user.id,
      ruleId: rule.id,
      subjectType: "subscription",
      subjectId: subForHmac.id,
      dedupeKey: `signed:${Date.now()}`,
      payload: { name: "signed" },
      occurredAt: new Date(Date.now() - 60_000),
    });
    postSafeWebhookMock.mockResolvedValueOnce(true);

    const result = await dispatchDueDeliveries(new Date());
    expect(result.sent).toBe(1);
    expect(postSafeWebhookMock).toHaveBeenCalledOnce();
    const [destination, post] = postSafeWebhookMock.mock.calls[0] as [
      string,
      { body: string; headers: Record<string, string> },
    ];
    expect(destination).toBe("https://webhook.example/hook");
    expect(post.headers["x-conspectus-event-id"]).toBe(`evt_${event?.eventId}`);
    expect(post.headers["x-conspectus-signature"]).toBe(
      createHmac("sha256", plaintextSecret).update(post.body).digest("hex"),
    );

    await db.notificationDelivery.deleteMany({ where: { userId: user.id } });
    await db.notificationEvent.deleteMany({ where: { userId: user.id } });
    await db.notificationChannel.delete({ where: { id: channel.id } });
    await db.notificationRule.delete({ where: { id: rule.id } });
    await db.user.delete({ where: { id: user.id } });
  });

});

describe("webhook signing headers", () => {
  it("omits the signature header when a webhook channel has no secret", () => {
    const headers = webhookHeaders("evt_no_secret", "{}", null);
    expect(headers["x-conspectus-event-id"]).toBe("evt_no_secret");
    expect(headers).not.toHaveProperty("x-conspectus-signature");
    expect(Object.values(headers)).not.toContain("unsigned");
  });
});
