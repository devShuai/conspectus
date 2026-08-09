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
  suspended?: boolean;
  /** both 模式（本地密码 + certus 关联）；本地邮箱唯一索引只覆盖这类行。 */
  localPassword?: boolean;
}) {
  return db.user.create({
    data: {
      certusSub: uniqueSub("v05x"),
      certusLinkStatus: "active",
      lastStatusSyncedAt: new Date(),
      timezone: "Asia/Shanghai",
      passwordHash: opts.localPassword ? "x".repeat(60) : null,
      email: `v05x-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
      emailVerifiedAt: new Date(),
      emailVerificationSource: opts.source,
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

function status200(body: {
  status?: string;
  /** #125：省略即模拟 certus 过旧 / 无 email scope，调用方必须 fail-closed。 */
  email?: string;
  emailVerified?: boolean;
  updatedAt?: Date;
}) {
  return {
    httpStatus: 200,
    active: (body.status ?? "active") === "active",
    status: body.status ?? "active",
    email: body.email,
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

  it("direct email: certus precheck proceeds when the address matches and is verified", async () => {
    const user = await setupCertusEmailUser({ source: "certus" });
    const channel = await setupEmailChannel(user.id);
    const delivery = await setupDueDelivery(user.id, channel.id);
    fetchUserStatusMock.mockResolvedValue(
      // #125：验证位与地址成对，且地址就是本地这一个 —— updated_at 不再参与判定
      status200({ email: user.email!, emailVerified: true, updatedAt: new Date() }),
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

  it("direct email: certus email_verified=false on the same address blocks terminally", async () => {
    const user = await setupCertusEmailUser({ source: "certus" });
    const channel = await setupEmailChannel(user.id);
    const delivery = await setupDueDelivery(user.id, channel.id);
    fetchUserStatusMock.mockResolvedValue(
      status200({ email: user.email!, emailVerified: false }),
    );

    await dispatchDueDeliveries(new Date());

    const after = await db.notificationDelivery.findUniqueOrThrow({
      where: { id: delivery.id },
    });
    expect(after.status).toBe("blocked");
    expect(sendEmailMock).not.toHaveBeenCalled();

    await db.user.delete({ where: { id: user.id } });
  });

  /*
   * #125：旧实现在这里比较 updated_at，只要它晚于登录快照就判定「可能变过」，
   * 延迟投递并等用户重新登录。certus 侧任何画像编辑（改个显示名就够）都会
   * bump updated_at，于是这条路径误报极多。现在直接比地址。
   */
  it("direct email: a changed address is adopted from certus, not deferred", async () => {
    const user = await setupCertusEmailUser({ source: "certus" });
    const channel = await setupEmailChannel(user.id);
    const delivery = await setupDueDelivery(user.id, channel.id);
    const moved = `moved-${Date.now()}@example.com`;
    fetchUserStatusMock.mockResolvedValue(
      // 地址变了但新地址已验证：采纳并照发，不必等下次登录
      status200({ email: moved, emailVerified: true, updatedAt: new Date() }),
    );

    await dispatchDueDeliveries(new Date());

    const after = await db.notificationDelivery.findUniqueOrThrow({
      where: { id: delivery.id },
    });
    expect(after.status).toBe("sent");
    const userAfter = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(userAfter.email).toBe(moved);
    expect(userAfter.emailVerifiedAt).not.toBeNull();
    expect(userAfter.emailVerificationSource).toBe("certus");

    await db.user.delete({ where: { id: user.id } });
  });

  it("direct email: a changed but unverified address is adopted and blocks", async () => {
    const user = await setupCertusEmailUser({ source: "certus" });
    const channel = await setupEmailChannel(user.id);
    const delivery = await setupDueDelivery(user.id, channel.id);
    const moved = `unverified-${Date.now()}@example.com`;
    fetchUserStatusMock.mockResolvedValue(
      status200({ email: moved, emailVerified: false, updatedAt: new Date() }),
    );

    await dispatchDueDeliveries(new Date());

    const after = await db.notificationDelivery.findUniqueOrThrow({
      where: { id: delivery.id },
    });
    expect(after.status).toBe("blocked");
    expect(sendEmailMock).not.toHaveBeenCalled(); // 绝不向未验证的新地址发信
    const userAfter = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(userAfter.email).toBe(moved);
    expect(userAfter.emailVerifiedAt).toBeNull();

    await db.user.delete({ where: { id: user.id } });
  });

  it("direct email: a response without an address defers fail-closed", async () => {
    const user = await setupCertusEmailUser({ source: "certus" });
    const channel = await setupEmailChannel(user.id);
    const delivery = await setupDueDelivery(user.id, channel.id);
    // certus 早于 e432373，或本客户端没有 email scope：无法成对校验
    fetchUserStatusMock.mockResolvedValue(status200({ emailVerified: true }));

    await dispatchDueDeliveries(new Date());

    const after = await db.notificationDelivery.findUniqueOrThrow({
      where: { id: delivery.id },
    });
    expect(after.status).toBe("pending");
    expect(after.attempts).toBe(0); // 门禁延迟不烧外呼 attempts
    expect(after.deferredReason).toBe("identity_email_unavailable");
    expect(sendEmailMock).not.toHaveBeenCalled(); // 不得沿用本地验证位

    await db.user.delete({ where: { id: user.id } });
  });

  /*
   * users_local_email_unique 是分区唯一索引，只覆盖 passwordHash IS NOT NULL 的
   * 行，所以采纳新地址撞车只可能发生在 both 模式账号之间 —— 但那一撞会让整批
   * 投递抛错中断，必须收成一次延迟。
   */
  it("direct email: adopting an address another local account holds defers, not crashes", async () => {
    const taken = `taken-${Date.now()}@example.com`;
    const other = await db.user.create({
      // certusSub 必须与 certusLinkStatus / lastStatusSyncedAt 成套（users_certus_link_pairing）
      data: {
        certusSub: uniqueSub("v05x-other"),
        certusLinkStatus: "active",
        lastStatusSyncedAt: new Date(),
        passwordHash: "x".repeat(60),
        email: taken,
        timezone: "UTC",
      },
    });
    const user = await setupCertusEmailUser({ source: "certus", localPassword: true });
    const channel = await setupEmailChannel(user.id);
    const delivery = await setupDueDelivery(user.id, channel.id);
    fetchUserStatusMock.mockResolvedValue(
      status200({ email: taken, emailVerified: true, updatedAt: new Date() }),
    );

    await dispatchDueDeliveries(new Date());

    const after = await db.notificationDelivery.findUniqueOrThrow({
      where: { id: delivery.id },
    });
    expect(after.status).toBe("pending");
    expect(after.deferredReason).toBe("identity_email_conflict");
    const userAfter = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(userAfter.email).not.toBe(taken); // 冲突时保持现状

    await db.user.delete({ where: { id: user.id } });
    await db.user.delete({ where: { id: other.id } });
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
    const user = await setupCertusEmailUser({ source: "certus" });
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
      status200({ email: user.email!, emailVerified: false }),
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

  it("status runner adopts a changed address, and never touches a local proof", async () => {
    const certusUser = await setupCertusEmailUser({ source: "certus" });
    const localUser = await setupCertusEmailUser({ source: "local" });
    const localAddressBefore = localUser.email;
    const moved = `runner-moved-${Date.now()}@example.com`;
    fetchUserStatusMock.mockResolvedValue(
      status200({ email: moved, emailVerified: true, updatedAt: new Date() }),
    );

    const outcome = await recheckIdentityStatus({
      userId: certusUser.id,
      certusSub: certusUser.certusSub!,
      config: FAKE_CONFIG,
      ttlMs: 0,
    });
    expect(outcome.kind).toBe("active");
    const after = await db.user.findUniqueOrThrow({ where: { id: certusUser.id } });
    expect(after.email).toBe(moved);
    expect(after.emailVerifiedAt).not.toBeNull();
    expect(after.emailVerificationSource).toBe("certus");

    // local 独立证明不得被 certus 状态响应改写（§7.6 both 模式）
    await recheckIdentityStatus({
      userId: localUser.id,
      certusSub: localUser.certusSub!,
      config: FAKE_CONFIG,
      ttlMs: 0,
    });
    const localAfter = await db.user.findUniqueOrThrow({ where: { id: localUser.id } });
    expect(localAfter.email).toBe(localAddressBefore);
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

  it("login re-establishes a certus proof for the address it was issued for", async () => {
    const user = await setupCertusEmailUser({ source: "certus" });
    await db.user.update({
      where: { id: user.id },
      data: { emailVerifiedAt: null, emailVerificationSource: null },
    });

    await upsertCertusUser({
      sub: user.certusSub!,
      email: user.email!,
      emailVerified: true,
      idTokenIat: Math.floor(Date.now() / 1000),
    });

    const after = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.emailVerifiedAt).not.toBeNull();
    expect(after.emailVerificationSource).toBe("certus");

    await db.user.delete({ where: { id: user.id } });
  });

  /*
   * #125 之后本地验证不再需要「清除快照标记 + 唤醒延迟行」：地址成对校验让
   * 门禁在下一轮复核时自行判定，延迟行按各自的退避重试恢复。这里保住的是它
   * 真正的职责——把证明来源接管为 local，此后 certus 状态不得再改写它。
   */
  it("local email verification takes over the proof and certus stops touching it", async () => {
    const user = await db.user.create({
      data: {
        certusSub: uniqueSub("v05x-both"),
        certusLinkStatus: "active",
        lastStatusSyncedAt: new Date(),
        passwordHash: "x".repeat(60),
        email: `v05x-both-${Date.now()}@example.com`,
      },
    });

    const token = await issueEmailVerificationToken(user.id, user.email!);
    await consumeEmailVerificationToken(token);

    const after = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.emailVerifiedAt).not.toBeNull();
    expect(after.emailVerificationSource).toBe("local");

    // certus 之后报告另一个地址也不得改写本地证明
    fetchUserStatusMock.mockResolvedValue(
      status200({ email: `elsewhere-${Date.now()}@example.com`, emailVerified: true }),
    );
    await recheckIdentityStatus({
      userId: user.id,
      certusSub: user.certusSub!,
      config: FAKE_CONFIG,
      ttlMs: 0,
    });
    const settled = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(settled.email).toBe(after.email);
    expect(settled.emailVerificationSource).toBe("local");

    await db.user.delete({ where: { id: user.id } });
  });
});
