import { beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "@/server/db";
import type { AuthConfig } from "@/server/auth/config";
import { recheckIdentityStatus } from "@/server/auth/identity-status";
import { upsertCertusUser } from "@/server/auth/jit-user";
import {
  consumeEmailVerificationToken,
  issueEmailVerificationToken,
} from "@/server/auth/one-time-tokens";

import { dispatchDueDeliveries } from "./dispatch";
import { dispatchDueDigests } from "./digest";
import { saveChannel } from "./manage";
import { emitEvent } from "./scan";
import { nextLocalTime } from "./schedule";

const { fetchUserStatusMock, sendEmailMock } = vi.hoisted(() => ({
  fetchUserStatusMock: vi.fn(),
  sendEmailMock: vi.fn(),
}));

vi.mock("@/server/auth/certus-client-api", () => ({
  fetchUserStatus: fetchUserStatusMock,
}));
vi.mock("@/server/auth/email-sender", () => ({
  sendEmail: sendEmailMock,
}));

const DISABLED = !process.env.TEST_DATABASE_URL;
const FAKE_CONFIG = {} as AuthConfig; // fetchUserStatus 已 mock，配置不会被触碰

function uniqueSub(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function setupCertusEmailUser(opts: {
  source: "certus" | "local";
  snapshotIssuedAt?: Date;
  suspended?: boolean;
}) {
  return db.user.create({
    data: {
      certusSub: uniqueSub("v05x"),
      certusLinkStatus: "active",
      lastStatusSyncedAt: new Date(),
      timezone: "Asia/Shanghai",
      email: `v05x-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
      emailVerifiedAt: new Date(),
      emailVerificationSource: opts.source,
      emailSnapshotIssuedAt: opts.snapshotIssuedAt ?? new Date(),
      status: opts.suspended ? "suspended" : "active",
      statusReason: opts.suspended ? "certus_locked" : null,
    },
  });
}

async function setupEmailChannel(userId: string, mode: "individual" | "daily_digest" = "individual") {
  return db.notificationChannel.create({
    data: { userId, type: "email", mode },
  });
}

async function setupDueDelivery(userId: string, channelId: string) {
  const rule = await db.notificationRule.create({
    data: { userId, type: "renewal_due", config: { daysBefore: [1] } },
  });
  // 投递前复核要求 subject 订阅真实存在且 active（否则按「subject 不适用」取消）
  const sub = await db.subscription.create({
    data: {
      userId,
      name: "V05x",
      price: 10,
      currency: "CNY",
      billingCycle: "monthly",
      startedAt: new Date("2026-01-01T00:00:00Z"),
      status: "active",
    },
  });
  const event = await emitEvent({
    userId,
    ruleId: rule.id,
    subjectType: "subscription",
    subjectId: sub.id,
    dedupeKey: `v05x-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    payload: { name: "x" },
    occurredAt: new Date(Date.now() - 60_000),
  });
  return db.notificationDelivery.findFirstOrThrow({
    where: { eventId: event?.eventId, channelId },
  });
}

function status200(body: { status?: string; emailVerified?: boolean; updatedAt?: Date }) {
  return {
    httpStatus: 200,
    active: (body.status ?? "active") === "active",
    status: body.status ?? "active",
    emailVerified: body.emailVerified,
    hasUpdatedAt: body.updatedAt !== undefined,
    updatedAt: body.updatedAt,
    notFoundOpaque: false,
    leakedProfileFields: [],
  };
}

describe.skipIf(DISABLED)("notification v0.5.x clauses (#116)", () => {
  beforeEach(() => {
    fetchUserStatusMock.mockReset();
    sendEmailMock.mockReset();
    sendEmailMock.mockResolvedValue(undefined);
  });

  it("digestLocalTime drives the digest batch clock (and stays email-only)", async () => {
    const user = await setupCertusEmailUser({ source: "local" });
    const saved = await saveChannel({
      userId: user.id,
      type: "email",
      mode: "daily_digest",
      digestLocalTime: "07:30",
    });
    const rule = await db.notificationRule.create({
      data: { userId: user.id, type: "renewal_due", config: { daysBefore: [1] } },
    });
    const before = new Date();
    await emitEvent({
      userId: user.id,
      ruleId: rule.id,
      subjectType: "subscription",
      subjectId: "00000000-0000-0000-0000-000000000116",
      dedupeKey: `v05x-time-${Date.now()}`,
      payload: { name: "x" },
    });
    const digest = await db.notificationDigest.findFirstOrThrow({
      where: { channelId: saved.channelId },
    });
    const expected = nextLocalTime(before, "Asia/Shanghai", 7, 30);
    expect(Math.abs(digest.scheduledAt.getTime() - expected.getTime())).toBeLessThan(5_000);

    await expect(
      saveChannel({
        userId: user.id,
        type: "webhook",
        mode: "individual",
        destination: "https://hook.example/t",
        digestLocalTime: "07:30",
      }),
    ).rejects.toMatchObject({ reason: "digest_time_email_only" });
    await expect(
      saveChannel({
        userId: user.id,
        type: "email",
        mode: "daily_digest",
        digestLocalTime: "25:00",
      }),
    ).rejects.toMatchObject({ reason: "invalid_digest_time" });

    await db.user.delete({ where: { id: user.id } });
  });

  it("direct email: certus precheck proceeds when snapshot is current and verified", async () => {
    const snapshot = new Date(Date.now() - 2 * 3_600_000);
    const user = await setupCertusEmailUser({ source: "certus", snapshotIssuedAt: snapshot });
    const channel = await setupEmailChannel(user.id);
    const delivery = await setupDueDelivery(user.id, channel.id);
    fetchUserStatusMock.mockResolvedValue(
      status200({ emailVerified: true, updatedAt: new Date(Date.now() - 3 * 3_600_000) }),
    );

    await dispatchDueDeliveries(new Date());

    const after = await db.notificationDelivery.findUniqueOrThrow({
      where: { id: delivery.id },
    });
    expect(after.status).toBe("sent");
    expect(fetchUserStatusMock).toHaveBeenCalled();
    expect(sendEmailMock).toHaveBeenCalled();

    await db.user.delete({ where: { id: user.id } });
  });

  it("direct email: certus email_verified=false on a compatible snapshot blocks terminally", async () => {
    const snapshot = new Date(Date.now() - 2 * 3_600_000);
    const user = await setupCertusEmailUser({ source: "certus", snapshotIssuedAt: snapshot });
    const channel = await setupEmailChannel(user.id);
    const delivery = await setupDueDelivery(user.id, channel.id);
    fetchUserStatusMock.mockResolvedValue(
      status200({ emailVerified: false, updatedAt: new Date(Date.now() - 3 * 3_600_000) }),
    );

    await dispatchDueDeliveries(new Date());

    const after = await db.notificationDelivery.findUniqueOrThrow({
      where: { id: delivery.id },
    });
    expect(after.status).toBe("blocked");
    expect(sendEmailMock).not.toHaveBeenCalled();

    await db.user.delete({ where: { id: user.id } });
  });

  it("direct email: newer updated_at defers with email_snapshot_stale and rewrites the user row", async () => {
    const snapshot = new Date(Date.now() - 2 * 3_600_000);
    const user = await setupCertusEmailUser({ source: "certus", snapshotIssuedAt: snapshot });
    const channel = await setupEmailChannel(user.id);
    const delivery = await setupDueDelivery(user.id, channel.id);
    fetchUserStatusMock.mockResolvedValue(
      status200({ emailVerified: true, updatedAt: new Date() }), // 快照后画像有变化
    );

    const now = new Date();
    await dispatchDueDeliveries(now);

    const after = await db.notificationDelivery.findUniqueOrThrow({
      where: { id: delivery.id },
    });
    expect(after.status).toBe("pending");
    expect(after.attempts).toBe(0); // 门禁延迟不烧外呼 attempts
    expect(after.deferredReason).toBe("email_snapshot_stale");
    expect(sendEmailMock).not.toHaveBeenCalled(); // 不得再消费该响应的验证位
    const userAfter = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(userAfter.emailSyncRequiredAt).not.toBeNull();
    expect(userAfter.emailVerifiedAt).toBeNull();
    expect(userAfter.emailVerificationSource).toBeNull();

    await db.user.delete({ where: { id: user.id } });
  });

  it("direct email: precheck failure defers fail-closed (429/网络), 404 means reauth", async () => {
    const user = await setupCertusEmailUser({ source: "certus" });
    const channel = await setupEmailChannel(user.id);
    const delivery = await setupDueDelivery(user.id, channel.id);

    fetchUserStatusMock.mockResolvedValue({
      httpStatus: 429,
      hasUpdatedAt: false,
      notFoundOpaque: false,
      retryAfter: "30",
      leakedProfileFields: [],
    });
    await dispatchDueDeliveries(new Date());
    let after = await db.notificationDelivery.findUniqueOrThrow({
      where: { id: delivery.id },
    });
    expect(after.status).toBe("pending");
    expect(after.deferredReason).toBe("identity_status_stale");
    expect(after.attempts).toBe(0);

    fetchUserStatusMock.mockResolvedValue({
      httpStatus: 404,
      hasUpdatedAt: false,
      notFoundOpaque: true,
      leakedProfileFields: [],
    });
    // 清掉延迟时间让下一轮立即可租
    await db.notificationDelivery.update({
      where: { id: delivery.id },
      data: { nextAttemptAt: null },
    });
    await dispatchDueDeliveries(new Date());
    after = await db.notificationDelivery.findUniqueOrThrow({
      where: { id: delivery.id },
    });
    expect(after.status).toBe("pending");
    expect(after.deferredReason).toBe("identity_reauth_required");
    expect(sendEmailMock).not.toHaveBeenCalled();

    await db.user.delete({ where: { id: user.id } });
  });

  it("digest email: per-batch certus precheck blocks batch + children together", async () => {
    const snapshot = new Date(Date.now() - 2 * 3_600_000);
    const user = await setupCertusEmailUser({ source: "certus", snapshotIssuedAt: snapshot });
    const channel = await setupEmailChannel(user.id, "daily_digest");
    const rule = await db.notificationRule.create({
      data: { userId: user.id, type: "renewal_due", config: { daysBefore: [1] } },
    });
    await emitEvent({
      userId: user.id,
      ruleId: rule.id,
      subjectType: "subscription",
      subjectId: "00000000-0000-0000-0000-000000000116",
      dedupeKey: `v05x-dg-${Date.now()}`,
      payload: { name: "x" },
    });
    const digest = await db.notificationDigest.findFirstOrThrow({
      where: { channelId: channel.id },
    });
    await db.notificationDigest.update({
      where: { id: digest.id },
      data: { scheduledAt: new Date(Date.now() - 60_000) },
    });
    fetchUserStatusMock.mockResolvedValue(
      status200({ emailVerified: false, updatedAt: new Date(Date.now() - 3 * 3_600_000) }),
    );

    await dispatchDueDigests(new Date());

    const after = await db.notificationDigest.findUniqueOrThrow({
      where: { id: digest.id },
    });
    expect(after.status).toBe("blocked");
    const children = await db.notificationDelivery.findMany({
      where: { digestId: digest.id },
    });
    expect(children.length).toBeGreaterThan(0);
    expect(children.every((c) => c.status === "blocked")).toBe(true);
    expect(sendEmailMock).not.toHaveBeenCalled();

    await db.user.delete({ where: { id: user.id } });
  });

  it("digest defer lands structured deferredReason (certus suspension)", async () => {
    const user = await setupCertusEmailUser({ source: "local", suspended: true });
    const channel = await setupEmailChannel(user.id, "daily_digest");
    const rule = await db.notificationRule.create({
      data: { userId: user.id, type: "renewal_due", config: { daysBefore: [1] } },
    });
    await emitEvent({
      userId: user.id,
      ruleId: rule.id,
      subjectType: "subscription",
      subjectId: "00000000-0000-0000-0000-000000000116",
      dedupeKey: `v05x-df-${Date.now()}`,
      payload: { name: "x" },
    });
    const digest = await db.notificationDigest.findFirstOrThrow({
      where: { channelId: channel.id },
    });
    await db.notificationDigest.update({
      where: { id: digest.id },
      data: { scheduledAt: new Date(Date.now() - 60_000) },
    });

    await dispatchDueDigests(new Date());

    const after = await db.notificationDigest.findUniqueOrThrow({
      where: { id: digest.id },
    });
    expect(after.status).toBe("pending");
    expect(after.deferredReason).toBe("identity_suspended_certus");
    expect(after.attempts).toBe(0);

    await db.user.delete({ where: { id: user.id } });
  });

  it("status runner writes emailSyncRequiredAt on newer updated_at (certus source only)", async () => {
    const snapshot = new Date(Date.now() - 2 * 3_600_000);
    const certusUser = await setupCertusEmailUser({ source: "certus", snapshotIssuedAt: snapshot });
    const localUser = await setupCertusEmailUser({ source: "local", snapshotIssuedAt: snapshot });
    fetchUserStatusMock.mockResolvedValue(
      status200({ emailVerified: true, updatedAt: new Date() }),
    );

    const outcome = await recheckIdentityStatus({
      userId: certusUser.id,
      certusSub: certusUser.certusSub!,
      config: FAKE_CONFIG,
      ttlMs: 0,
    });
    expect(outcome.kind).toBe("active");
    const after = await db.user.findUniqueOrThrow({ where: { id: certusUser.id } });
    expect(after.emailSyncRequiredAt).not.toBeNull();
    expect(after.emailVerifiedAt).toBeNull();
    expect(after.emailVerificationSource).toBeNull();

    // local 独立证明不得被 certus 状态响应清除（§7.6 both 模式）
    await recheckIdentityStatus({
      userId: localUser.id,
      certusSub: localUser.certusSub!,
      config: FAKE_CONFIG,
      ttlMs: 0,
    });
    const localAfter = await db.user.findUniqueOrThrow({ where: { id: localUser.id } });
    expect(localAfter.emailSyncRequiredAt).toBeNull();
    expect(localAfter.emailVerifiedAt).not.toBeNull();
    expect(localAfter.emailVerificationSource).toBe("local");

    await db.user.delete({ where: { id: certusUser.id } });
    await db.user.delete({ where: { id: localUser.id } });
  });

  it("identity recovery pushes nextAttemptAt back to now for identity-deferred rows", async () => {
    const user = await setupCertusEmailUser({ source: "local", suspended: true });
    const channel = await setupEmailChannel(user.id);
    const delivery = await setupDueDelivery(user.id, channel.id);
    const future = new Date(Date.now() + 3_600_000);
    await db.notificationDelivery.update({
      where: { id: delivery.id },
      data: { deferredReason: "identity_suspended_certus", nextAttemptAt: future },
    });
    const digest = await db.notificationDigest.create({
      data: {
        userId: user.id,
        channelId: channel.id,
        localDate: new Date("2020-01-02T00:00:00Z"),
        scheduledAt: new Date(Date.now() - 60_000),
        deferredReason: "identity_suspended_certus",
        nextAttemptAt: future,
      },
    });
    fetchUserStatusMock.mockResolvedValue(status200({ emailVerified: true }));

    const before = new Date();
    const outcome = await recheckIdentityStatus({
      userId: user.id,
      certusSub: user.certusSub!,
      config: FAKE_CONFIG,
      ttlMs: 0,
    });
    expect(outcome.kind).toBe("active");
    const userAfter = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(userAfter.status).toBe("active");

    const deliveryAfter = await db.notificationDelivery.findUniqueOrThrow({
      where: { id: delivery.id },
    });
    expect(deliveryAfter.nextAttemptAt!.getTime()).toBeLessThan(future.getTime());
    expect(deliveryAfter.nextAttemptAt!.getTime()).toBeGreaterThanOrEqual(before.getTime() - 5_000);
    const digestAfter = await db.notificationDigest.findUniqueOrThrow({
      where: { id: digest.id },
    });
    expect(digestAfter.nextAttemptAt!.getTime()).toBeLessThan(future.getTime());

    await db.user.delete({ where: { id: user.id } });
  });

  it("login with a fresh verified pair clears emailSyncRequiredAt and wakes email-deferred rows", async () => {
    const user = await setupCertusEmailUser({
      source: "certus",
      snapshotIssuedAt: new Date(Date.now() - 2 * 3_600_000),
    });
    await db.user.update({
      where: { id: user.id },
      data: {
        emailSyncRequiredAt: new Date(),
        emailVerifiedAt: null,
        emailVerificationSource: null,
      },
    });
    const channel = await setupEmailChannel(user.id);
    const delivery = await setupDueDelivery(user.id, channel.id);
    const future = new Date(Date.now() + 3_600_000);
    await db.notificationDelivery.update({
      where: { id: delivery.id },
      data: { deferredReason: "email_snapshot_stale", nextAttemptAt: future },
    });

    const before = new Date();
    await upsertCertusUser({
      sub: user.certusSub!,
      email: user.email!,
      emailVerified: true,
      idTokenIat: Math.floor(Date.now() / 1000),
    });

    const after = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.emailSyncRequiredAt).toBeNull();
    expect(after.emailVerificationSource).toBe("certus");
    const deliveryAfter = await db.notificationDelivery.findUniqueOrThrow({
      where: { id: delivery.id },
    });
    expect(deliveryAfter.nextAttemptAt!.getTime()).toBeLessThan(future.getTime());
    expect(deliveryAfter.nextAttemptAt!.getTime()).toBeGreaterThanOrEqual(before.getTime() - 5_000);

    await db.user.delete({ where: { id: user.id } });
  });

  it("local email verification clears emailSyncRequiredAt and wakes email-deferred rows", async () => {
    // both 模式用户：本地密码 + certus 关联（emailSyncRequiredAt 的 CHECK 要求 certusSub 非空）
    const user = await db.user.create({
      data: {
        certusSub: uniqueSub("v05x-both"),
        certusLinkStatus: "active",
        lastStatusSyncedAt: new Date(),
        passwordHash: "x".repeat(60),
        email: `v05x-both-${Date.now()}@example.com`,
        emailSyncRequiredAt: new Date(),
      },
    });
    const channel = await setupEmailChannel(user.id);
    const delivery = await setupDueDelivery(user.id, channel.id);
    const future = new Date(Date.now() + 3_600_000);
    await db.notificationDelivery.update({
      where: { id: delivery.id },
      data: { deferredReason: "email_snapshot_stale", nextAttemptAt: future },
    });

    const token = await issueEmailVerificationToken(user.id, user.email!);
    await consumeEmailVerificationToken(token);

    const after = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.emailSyncRequiredAt).toBeNull();
    expect(after.emailVerificationSource).toBe("local");
    const deliveryAfter = await db.notificationDelivery.findUniqueOrThrow({
      where: { id: delivery.id },
    });
    expect(deliveryAfter.nextAttemptAt!.getTime()).toBeLessThan(future.getTime());

    await db.user.delete({ where: { id: user.id } });
  });
});
