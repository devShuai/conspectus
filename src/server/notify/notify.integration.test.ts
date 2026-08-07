import { describe, expect, it } from "vitest";

import { db } from "@/server/db";
import { armOrSkip, clearArm, emitEvent, runNotificationScan } from "./scan.js";
import { dispatchDueDeliveries } from "./dispatch.js";

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
    expect(result.events).toBe(1);

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
    const event = await emitEvent({
      userId: user.id,
      ruleId: rule.id,
      subjectType: "subscription",
      subjectId: "00000000-0000-0000-0000-0000000000cc",
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
      subjectId: "00000000-0000-0000-0000-0000000000cd",
      dedupeKey: "renewal:2026-03-02:d1",
      payload: { name: "y" },
    });
    const result2 = await dispatchDueDeliveries(new Date());
    expect(result2.retried).toBeGreaterThanOrEqual(1);
    const webhookDelivery = await db.notificationDelivery.findFirst({
      where: { eventId: event2?.eventId, channelId: webhookChannel.id },
    });
    expect(webhookDelivery?.status).toBe("pending");
    expect(webhookDelivery?.attempts).toBe(1);
    expect(webhookDelivery?.nextAttemptAt).not.toBeNull();

    await db.notificationDelivery.deleteMany({ where: { userId: user.id } });
    await db.notificationEvent.deleteMany({ where: { userId: user.id } });
    await db.notificationChannel.deleteMany({ where: { userId: user.id } });
    await db.notificationRule.deleteMany({ where: { userId: user.id } });
    await db.user.delete({ where: { id: user.id } });
  });
});
