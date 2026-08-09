import { beforeEach, describe, expect, it, vi } from "vitest";

import type { NotificationRuleType } from "@prisma/client";

import { db } from "@/server/db";
import { encryptCredential, loadCredentialKeyring } from "@/server/auth/crypto";

import { dispatchDueDeliveries, RETRY_STEPS_MS } from "./dispatch";
import { emitArmedEvent, emitEvent, runNotificationScan } from "./scan";
import { renderNotificationEmail } from "./email-templates";
import { nextLocalTime } from "./schedule";

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

async function setupUser(opts: { timezone?: string; emailVerified?: boolean } = {}) {
  return db.user.create({
    data: {
      certusSub: uniqueSub("n110"),
      certusLinkStatus: "active",
      lastStatusSyncedAt: new Date(),
      timezone: opts.timezone ?? "Asia/Shanghai",
      email: `n110-${Date.now()}@example.com`,
      emailVerifiedAt: opts.emailVerified === false ? null : new Date(),
      emailVerificationSource: opts.emailVerified === false ? null : "local",
    },
  });
}

async function setupRule(userId: string, type: NotificationRuleType, config: object = {}) {
  return db.notificationRule.create({ data: { userId, type, config } });
}

async function cleanup(userId: string) {
  await db.user.delete({ where: { id: userId } });
}

describe.skipIf(DISABLED)("notification runtime semantics (#110)", () => {
  beforeEach(() => {
    postSafeWebhookMock.mockReset();
    postSafeWebhookMock.mockResolvedValue(false);
  });

  it("scan filters by rule type: renewal_due only active, trial_ending only trial", async () => {
    const user = await setupUser();
    const renewalRule = await setupRule(user.id, "renewal_due", { daysBefore: [7] });
    const trialRule = await setupRule(user.id, "trial_ending", { daysBefore: [7] });
    const in7days = new Date(Date.now() + 7 * 86_400_000);

    // trial 订阅有 nextBillingAt：renewal_due 不得触发（此前统一 [active,trial] 会误报）
    await db.subscription.create({
      data: {
        userId: user.id,
        name: "TrialSub",
        price: 10,
        currency: "CNY",
        billingCycle: "monthly",
        startedAt: new Date("2026-01-01T00:00:00Z"),
        nextBillingAt: in7days,
        trialEndsAt: in7days,
        status: "trial",
      },
    });
    await db.subscription.create({
      data: {
        userId: user.id,
        name: "ActiveSub",
        price: 10,
        currency: "CNY",
        billingCycle: "monthly",
        startedAt: new Date("2026-01-01T00:00:00Z"),
        nextBillingAt: in7days,
        status: "active",
      },
    });

    const events = await db.notificationEvent.findMany({ where: { userId: user.id } });
    expect(events.length).toBe(0);
    await runNotificationScan(new Date());
    const after = await db.notificationEvent.findMany({
      where: { userId: user.id },
      include: { rule: { select: { type: true } } },
    });
    // renewal_due 只发 ActiveSub；trial_ending 只发 TrialSub（trial 的 nextBillingAt 不误触发 renewal）
    const renewalEvents = after.filter((e) => e.rule.type === "renewal_due");
    const trialEvents = after.filter((e) => e.rule.type === "trial_ending");
    expect(renewalEvents.length).toBe(1);
    expect(trialEvents.length).toBe(1);

    await cleanup(user.id);
    void renewalRule;
    void trialRule;
  });

  it("reminder deliveries are scheduled at next local 09:00, operational ones immediately", async () => {
    const user = await setupUser({ timezone: "Asia/Shanghai" });
    await setupRule(user.id, "renewal_due", { daysBefore: [7] });
    await db.notificationChannel.create({
      data: { userId: user.id, type: "email", mode: "individual" },
    });
    await db.subscription.create({
      data: {
        userId: user.id,
        name: "Due",
        price: 10,
        currency: "CNY",
        billingCycle: "monthly",
        startedAt: new Date("2026-01-01T00:00:00Z"),
        nextBillingAt: new Date(Date.now() + 7 * 86_400_000),
        status: "active",
      },
    });

    const now = new Date();
    await runNotificationScan(now);
    const delivery = await db.notificationDelivery.findFirstOrThrow({
      where: { userId: user.id },
    });
    // 续费提醒排程到下一个本地 09:00（Asia/Shanghai 09:00 = 01:00 UTC），不是立即发
    expect(delivery.scheduledAt.getTime()).toBeGreaterThan(now.getTime());
    const expected = nextLocalTime(now, "Asia/Shanghai", 9);
    expect(delivery.scheduledAt.getTime()).toBe(expected.getTime());

    await cleanup(user.id);
  });

  it("stale identity no longer swallows the event at scan time (dispatch defers instead)", async () => {
    const user = await setupUser();
    // 状态复核过期（MAX_STALE=24h）：扫描不得吞事件，投递侧 pending 延迟
    await db.user.update({
      where: { id: user.id },
      data: { lastStatusSyncedAt: new Date(Date.now() - 48 * 3600_000) },
    });
    await setupRule(user.id, "renewal_due", { daysBefore: [7] });
    await db.notificationChannel.create({
      data: { userId: user.id, type: "email", mode: "individual" },
    });
    await db.subscription.create({
      data: {
        userId: user.id,
        name: "Due",
        price: 10,
        currency: "CNY",
        billingCycle: "monthly",
        startedAt: new Date("2026-01-01T00:00:00Z"),
        nextBillingAt: new Date(Date.now() + 7 * 86_400_000),
        status: "active",
      },
    });

    await runNotificationScan(new Date());
    // 全局扫描会处理其他并发 fixture 的规则 —— 只断言本 user 的 renewal_due 事件已建
    const mine = await db.notificationEvent.findMany({
      where: { userId: user.id, rule: { type: "renewal_due" } },
    });
    expect(mine.length).toBe(1); // 身份过期不再吞事件（#110）

    // 投递侧：立即件被 defer 回 pending 且不烧 attempts（复用已建 delivery，排程拨到过去）
    const existing = await db.notificationDelivery.findFirstOrThrow({
      where: { userId: user.id },
    });
    await db.notificationDelivery.update({
      where: { id: existing.id },
      data: { scheduledAt: new Date(Date.now() - 60_000) },
    });
    await dispatchDueDeliveries(new Date());
    // 并发调度可能由其他轮完成 defer —— 断言 delivery 终态而非本轮计数
    const after = await db.notificationDelivery.findUniqueOrThrow({
      where: { id: existing.id },
    });
    expect(after.status).toBe("pending");
    expect(after.attempts).toBe(0);
    expect(after.deferredReason).toBe("identity_status_stale"); // #116：结构化门禁原因

    await cleanup(user.id);
  });

  it("suspended admin cancels but certus reason defers", async () => {
    const user = await setupUser();
    const rule = await setupRule(user.id, "renewal_due");
    const channel = await db.notificationChannel.create({
      data: { userId: user.id, type: "email", mode: "individual" },
    });
    const event = await emitEvent({
      userId: user.id,
      ruleId: rule.id,
      subjectType: "subscription",
      subjectId: "00000000-0000-0000-0000-000000000001",
      dedupeKey: `k-${Date.now()}`,
      payload: { name: "x" },
      occurredAt: new Date(Date.now() - 60_000),
    });

    await db.user.update({
      where: { id: user.id },
      data: { status: "suspended", statusReason: "certus_locked" },
    });
    await dispatchDueDeliveries(new Date());
    // 并发调度可能由其他轮完成 defer —— 断言 delivery 终态而非本轮计数
    const delivery = await db.notificationDelivery.findFirstOrThrow({
      where: { eventId: event?.eventId, channelId: channel.id },
    });
    expect(delivery.status).toBe("pending");
    expect(delivery.deferredReason).toBe("identity_suspended_certus"); // #116：结构化门禁原因

    await db.user.update({
      where: { id: user.id },
      data: { statusReason: "admin" },
    });
    const result2 = await dispatchDueDeliveries(new Date(Date.now() + 6 * 60_000));
    // 并发测试的 delivery 可能同批取消，断言本条终态而不是全局计数
    const final = await db.notificationDelivery.findUniqueOrThrow({
      where: { id: delivery.id },
    });
    expect(final.status).toBe("canceled");
    expect(result2.canceled).toBeGreaterThanOrEqual(1);

    await cleanup(user.id);
  });

  it("retry ladder reaches the 30-minute step before failing", async () => {
    const user = await setupUser();
    const rule = await setupRule(user.id, "renewal_due");
    const channel = await db.notificationChannel.create({
      data: {
        userId: user.id,
        type: "webhook",
        mode: "individual",
        destination: "http://127.0.0.1:9/never",
        secretCipher: Buffer.from(new Uint8Array(16).fill(7)),
      },
    });
    // subject 必须是真实存在的 active 订阅，否则发送前复核按「subject 不适用」取消
    const sub = await db.subscription.create({
      data: {
        userId: user.id,
        name: "Retry",
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
      subjectId: sub.id,
      dedupeKey: `k2-${Date.now()}`,
      payload: { name: "x" },
      occurredAt: new Date(Date.now() - 60_000),
    });
    const deliveryId = (
      await db.notificationDelivery.findFirstOrThrow({
        where: { eventId: event?.eventId, channelId: channel.id },
      })
    ).id;

    const t0 = new Date();
    // 并发测试共用全局 dispatcher，attempts 只增不减 —— 断言阶梯终态而非逐轮精确值
    await dispatchDueDeliveries(t0); // fail ≥1 → pending
    let d = await db.notificationDelivery.findUniqueOrThrow({ where: { id: deliveryId } });
    expect(d.status).toBe("pending");
    expect(d.attempts).toBeGreaterThanOrEqual(1);

    await dispatchDueDeliveries(new Date(t0.getTime() + RETRY_STEPS_MS[0]));
    d = await db.notificationDelivery.findUniqueOrThrow({ where: { id: deliveryId } });
    expect(d.attempts).toBeGreaterThanOrEqual(2);

    await dispatchDueDeliveries(new Date(t0.getTime() + RETRY_STEPS_MS[0] + RETRY_STEPS_MS[1]));
    d = await db.notificationDelivery.findUniqueOrThrow({ where: { id: deliveryId } });
    expect(d.attempts).toBeGreaterThanOrEqual(3);
    expect(d.status).toBe("pending"); // 30min 档可达（此前 off-by-one 不可达）

    await dispatchDueDeliveries(
      new Date(t0.getTime() + RETRY_STEPS_MS[0] + RETRY_STEPS_MS[1] + RETRY_STEPS_MS[2]),
    );
    d = await db.notificationDelivery.findUniqueOrThrow({ where: { id: deliveryId } });
    expect(d.status).toBe("failed");

    await cleanup(user.id);
  });

  it("cancels when the rule got disabled or the subject subscription got canceled", async () => {
    const user = await setupUser();
    const rule = await setupRule(user.id, "renewal_due");
    const channel = await db.notificationChannel.create({
      data: { userId: user.id, type: "email", mode: "individual" },
    });
    const sub = await db.subscription.create({
      data: {
        userId: user.id,
        name: "Sub",
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
      subjectId: sub.id,
      dedupeKey: `k3-${Date.now()}`,
      payload: { name: "x" },
      occurredAt: new Date(Date.now() - 60_000),
    });

    // subject 取消 → canceled
    await db.subscription.update({ where: { id: sub.id }, data: { status: "canceled" } });
    const result = await dispatchDueDeliveries(new Date());
    expect(result.canceled).toBe(1);

    // rule 停用 → canceled
    await db.subscription.update({ where: { id: sub.id }, data: { status: "active" } });
    await db.notificationRule.update({ where: { id: rule.id }, data: { enabled: false } });
    const event2 = await emitEvent({
      userId: user.id,
      ruleId: rule.id,
      subjectType: "subscription",
      subjectId: sub.id,
      dedupeKey: `k4-${Date.now()}`,
      payload: { name: "x" },
      occurredAt: new Date(Date.now() - 60_000),
    });
    // emitEvent 在 rule 停用前已建的事件也应取消
    const result2 = await dispatchDueDeliveries(new Date());
    expect(result2.canceled).toBeGreaterThanOrEqual(1);
    void channel;
    void event2;

    await cleanup(user.id);
  });

  it("emitArmedEvent arms and emits atomically; only one concurrent worker wins", async () => {
    const user = await setupUser();
    const rule = await setupRule(user.id, "balance_low", { minValue: 10 });
    await db.notificationChannel.create({
      data: { userId: user.id, type: "email", mode: "individual" },
    });
    const subjectId = "00000000-0000-0000-0000-0000000000aa";

    const [first, second] = await Promise.all([
      emitArmedEvent({
        userId: user.id,
        ruleId: rule.id,
        subjectType: "quota",
        subjectId,
        dedupeKey: `arm-${Date.now()}`,
        arm: { armKey: `key-${Date.now()}` },
        payload: { name: "x" },
      }),
      emitArmedEvent({
        userId: user.id,
        ruleId: rule.id,
        subjectType: "quota",
        subjectId,
        dedupeKey: `arm-${Date.now()}`,
        arm: { armKey: `key-${Date.now()}` },
        payload: { name: "x" },
      }),
    ]);
    // 只有一个 worker 赢得 CAS 并建事件
    expect([first, second].filter((r) => r !== null).length).toBeLessThanOrEqual(1);
    const events = await db.notificationEvent.findMany({ where: { userId: user.id } });
    expect(events.length).toBeLessThanOrEqual(1);

    await cleanup(user.id);
  });

  it("webhook payload uses rule type + subscription wrapper + timestamp header", async () => {
    const user = await setupUser();
    const rule = await setupRule(user.id, "renewal_due");
    await db.notificationChannel.create({
      data: {
        userId: user.id,
        type: "webhook",
        mode: "individual",
        destination: "https://hook.example/x",
        secretCipher: new Uint8Array(
          encryptCredential(Buffer.from("hook-secret", "utf8"), loadCredentialKeyring()),
        ),
      },
    });
    const sub = await db.subscription.create({
      data: {
        userId: user.id,
        name: "PayloadSub",
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
      subjectId: sub.id,
      dedupeKey: `k5-${Date.now()}`,
      payload: { subscriptionId: sub.id, name: "Claude Max", vendor: "Anthropic", extra: 1 },
      occurredAt: new Date(Date.now() - 60_000),
    });
    postSafeWebhookMock.mockResolvedValueOnce(true);

    await dispatchDueDeliveries(new Date());
    // 并发调度可能由其他轮完成发送 —— 断言终态与签名头，而非本轮计数
    const sentDelivery = await db.notificationDelivery.findFirstOrThrow({
      where: { eventId: event?.eventId },
    });
    expect(sentDelivery.status).toBe("sent");
    const [, post] = postSafeWebhookMock.mock.calls[0] as [
      string,
      { body: string; headers: Record<string, string> },
    ];
    const body = JSON.parse(post.body) as {
      event: string;
      subscription: { id: string; name: string; vendor: string };
    };
    expect(body.event).toBe("renewal_due"); // 规则类型，不是 subjectType
    expect(body.subscription).toEqual({ id: sub.id, name: "Claude Max", vendor: "Anthropic" });
    expect(post.headers["x-conspectus-timestamp"]).toMatch(/^\d{10}$/);

    await cleanup(user.id);
    void event;
  });

  it("email is templated, not a JSON dump", () => {
    const { subject, text } = renderNotificationEmail({
      ruleType: "renewal_due",
      payload: { name: "Claude Max", daysBefore: "7", dueDate: "2026-08-15", amount: "1440.00", currency: "CNY" },
    });
    expect(subject).toContain("Claude Max");
    expect(subject).toContain("续费");
    expect(text).toContain("2026-08-15");
    expect(text).toContain("CNY 1440.00");
    expect(text).not.toContain("{");
  });
});
