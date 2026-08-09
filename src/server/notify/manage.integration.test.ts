import { createHmac } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "@/server/db";
import { decryptCredential, loadCredentialKeyring } from "@/server/auth/crypto";

import {
  NotificationAdminError,
  readWebhookSecret,
  rotateWebhookSecret,
  saveChannel,
  saveRule,
  setChannelEnabled,
} from "./manage";
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
      certusSub: uniqueSub("manage115"),
      certusLinkStatus: "active",
      lastStatusSyncedAt: new Date(),
      email: `m115-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
      emailVerifiedAt: new Date(),
      emailVerificationSource: "local",
    },
  });
}

function decrypt(channel: { secretCipher: Uint8Array | null }): string {
  expect(channel.secretCipher).not.toBeNull();
  return decryptCredential(channel.secretCipher!, loadCredentialKeyring()).toString("utf8");
}

describe.skipIf(DISABLED)("notification channel/rule management (#115)", () => {
  beforeEach(() => {
    postSafeWebhookMock.mockReset();
    postSafeWebhookMock.mockResolvedValue(true);
  });

  it("creates email channels in both modes without destination", async () => {
    const user = await setupUser();
    const individual = await saveChannel({ userId: user.id, type: "email", mode: "individual" });
    const digest = await saveChannel({ userId: user.id, type: "email", mode: "daily_digest" });
    const channels = await db.notificationChannel.findMany({ where: { userId: user.id } });
    expect(channels.length).toBe(2);
    expect(individual.enabled).toBe(true);
    expect(digest.enabled).toBe(true);
    expect(channels.every((c) => c.destination === null && c.secretCipher === null)).toBe(true);

    await db.user.delete({ where: { id: user.id } });
  });

  it("rejects daily_digest for webhook and destination for email", async () => {
    const user = await setupUser();
    await expect(
      saveChannel({
        userId: user.id,
        type: "webhook",
        mode: "daily_digest",
        destination: "https://hook.example/x",
      }),
    ).rejects.toMatchObject({ reason: "webhook_digest_unsupported" });
    await expect(
      saveChannel({
        userId: user.id,
        type: "email",
        mode: "individual",
        destination: "https://hook.example/x",
      }),
    ).rejects.toMatchObject({ reason: "destination_webhook_only" });
    await expect(
      saveChannel({ userId: user.id, type: "webhook", mode: "individual" }),
    ).rejects.toMatchObject({ reason: "destination_required" });
    expect(await db.notificationChannel.count({ where: { userId: user.id } })).toBe(0);

    await db.user.delete({ where: { id: user.id } });
  });

  it("saves a verified webhook channel enabled, with a signed verification POST", async () => {
    const user = await setupUser();
    const result = await saveChannel({
      userId: user.id,
      type: "webhook",
      mode: "individual",
      destination: "https://hook.example/verify",
    });
    expect(result.verified).toBe(true);
    expect(result.enabled).toBe(true);

    const channel = await db.notificationChannel.findUniqueOrThrow({
      where: { id: result.channelId },
    });
    expect(channel.enabled).toBe(true);
    expect(channel.secretCipher).not.toBeNull();

    // 验证性 POST 带签名三件套，签名可用入库密钥复核
    expect(postSafeWebhookMock).toHaveBeenCalledOnce();
    const [destination, post] = postSafeWebhookMock.mock.calls[0] as [
      string,
      { body: string; headers: Record<string, string> },
    ];
    expect(destination).toBe("https://hook.example/verify");
    const body = JSON.parse(post.body) as { id: string; event: string };
    expect(body.event).toBe("webhook_verify");
    expect(post.headers["x-conspectus-event-id"]).toBe(body.id);
    expect(post.headers["x-conspectus-timestamp"]).toMatch(/^\d{10}$/);
    const secret = decrypt(channel);
    expect(post.headers["x-conspectus-signature"]).toBe(
      createHmac("sha256", secret).update(post.body).digest("hex"),
    );
    // 密钥用户可见
    expect(readWebhookSecret(channel.secretCipher)).toBe(secret);

    await db.user.delete({ where: { id: user.id } });
  });

  it("failed verification POST saves the channel disabled; re-enable re-verifies", async () => {
    const user = await setupUser();
    postSafeWebhookMock.mockResolvedValue(false);
    const created = await saveChannel({
      userId: user.id,
      type: "webhook",
      mode: "individual",
      destination: "https://hook.example/down",
    });
    expect(created.verified).toBe(false);
    let channel = await db.notificationChannel.findUniqueOrThrow({
      where: { id: created.channelId },
    });
    expect(channel.enabled).toBe(false); // 未通过落 enabled=false（§7.6）

    // 修复目标后重新启用：再跑一次验证性 POST
    postSafeWebhookMock.mockResolvedValue(true);
    const enabled = await setChannelEnabled({
      userId: user.id,
      channelId: channel.id,
      enabled: true,
    });
    expect(enabled).toMatchObject({ enabled: true, verified: true });
    channel = await db.notificationChannel.findUniqueOrThrow({
      where: { id: created.channelId },
    });
    expect(channel.enabled).toBe(true);

    // 停用不触发验证
    postSafeWebhookMock.mockClear();
    await setChannelEnabled({ userId: user.id, channelId: channel.id, enabled: false });
    expect(postSafeWebhookMock).not.toHaveBeenCalled();
    channel = await db.notificationChannel.findUniqueOrThrow({
      where: { id: created.channelId },
    });
    expect(channel.enabled).toBe(false);

    await db.user.delete({ where: { id: user.id } });
  });

  it("secret rotation rewrites secretCipher and invalidates old signatures immediately", async () => {
    const user = await setupUser();
    const created = await saveChannel({
      userId: user.id,
      type: "webhook",
      mode: "individual",
      destination: "https://hook.example/rotate",
    });
    const before = await db.notificationChannel.findUniqueOrThrow({
      where: { id: created.channelId },
    });
    const oldSecret = decrypt(before);
    const oldHeaders = webhookHeaders("evt_x", "{}", before.secretCipher);

    await rotateWebhookSecret({ userId: user.id, channelId: before.id });

    const after = await db.notificationChannel.findUniqueOrThrow({
      where: { id: created.channelId },
    });
    const newSecret = decrypt(after);
    expect(newSecret).not.toBe(oldSecret);
    const newHeaders = webhookHeaders("evt_x", "{}", after.secretCipher);
    // 旧密钥签出的签名不再等于当前签名；当前签名只认新密钥
    expect(newHeaders["x-conspectus-signature"]).not.toBe(
      oldHeaders["x-conspectus-signature"],
    );
    expect(newHeaders["x-conspectus-signature"]).toBe(
      createHmac("sha256", newSecret).update("{}").digest("hex"),
    );
    expect(oldHeaders["x-conspectus-signature"]).toBe(
      createHmac("sha256", oldSecret).update("{}").digest("hex"),
    );

    // email 渠道没有密钥可轮换
    const email = await saveChannel({ userId: user.id, type: "email", mode: "individual" });
    await expect(
      rotateWebhookSecret({ userId: user.id, channelId: email.channelId }),
    ).rejects.toMatchObject({ reason: "secret_webhook_only" });

    await db.user.delete({ where: { id: user.id } });
  });

  it("tenant isolation: another user's channel cannot be saved, toggled or rotated", async () => {
    const owner = await setupUser();
    const stranger = await setupUser();
    const created = await saveChannel({
      userId: owner.id,
      type: "webhook",
      mode: "individual",
      destination: "https://hook.example/tenant",
    });

    await expect(
      saveChannel({
        userId: stranger.id,
        channelId: created.channelId,
        type: "webhook",
        mode: "individual",
        destination: "https://evil.example/x",
      }),
    ).rejects.toMatchObject({ reason: "channel_not_found" });
    await expect(
      setChannelEnabled({ userId: stranger.id, channelId: created.channelId, enabled: false }),
    ).rejects.toMatchObject({ reason: "channel_not_found" });
    await expect(
      rotateWebhookSecret({ userId: stranger.id, channelId: created.channelId }),
    ).rejects.toMatchObject({ reason: "channel_not_found" });

    await db.user.delete({ where: { id: owner.id } });
    await db.user.delete({ where: { id: stranger.id } });
  });

  it("saves, edits and disables rules; delete falls to enabled=false", async () => {
    const user = await setupUser();
    const created = await saveRule({
      userId: user.id,
      type: "renewal_due",
      config: { daysBefore: [1, 7, 7] },
    });
    let rule = await db.notificationRule.findUniqueOrThrow({ where: { id: created.ruleId } });
    expect(rule.enabled).toBe(true);
    expect(rule.config).toEqual({ daysBefore: [7, 1] }); // 归一化：去重 + 降序

    // 改配置
    await saveRule({
      userId: user.id,
      ruleId: rule.id,
      type: "renewal_due",
      config: { daysBefore: [3] },
    });
    rule = await db.notificationRule.findUniqueOrThrow({ where: { id: created.ruleId } });
    expect(rule.config).toEqual({ daysBefore: [3] });

    // 启停开关不传配置 → 保留原配置
    await saveRule({ userId: user.id, ruleId: rule.id, type: "renewal_due", enabled: false });
    rule = await db.notificationRule.findUniqueOrThrow({ where: { id: created.ruleId } });
    expect(rule.enabled).toBe(false); // 「删除」落 enabled=false（§7.6）
    expect(rule.config).toEqual({ daysBefore: [3] });

    // 非法配置
    await expect(
      saveRule({ userId: user.id, type: "renewal_due", config: { daysBefore: [] } }),
    ).rejects.toMatchObject({ reason: "invalid_rule_config" });
    await expect(
      saveRule({ userId: user.id, type: "balance_low", config: {} }),
    ).rejects.toMatchObject({ reason: "invalid_rule_config" });
    await expect(
      saveRule({ userId: user.id, type: "usage_threshold", config: { percent: [120] } }),
    ).rejects.toMatchObject({ reason: "invalid_rule_config" });

    // price_change 无配置，多余键被剥掉
    const price = await saveRule({
      userId: user.id,
      type: "price_change",
      config: { daysBefore: [9] },
    });
    const priceRule = await db.notificationRule.findUniqueOrThrow({
      where: { id: price.ruleId },
    });
    expect(priceRule.config).toEqual({});

    await db.user.delete({ where: { id: user.id } });
  });

  it("rule subscription scope must belong to the user; rules are tenant-isolated", async () => {
    const user = await setupUser();
    const stranger = await setupUser();
    const foreignSub = await db.subscription.create({
      data: {
        userId: stranger.id,
        name: "Foreign",
        price: 10,
        currency: "CNY",
        billingCycle: "monthly",
        startedAt: new Date("2026-01-01T00:00:00Z"),
        status: "active",
      },
    });

    await expect(
      saveRule({
        userId: user.id,
        type: "renewal_due",
        config: { daysBefore: [7] },
        subscriptionId: foreignSub.id,
      }),
    ).rejects.toMatchObject({ reason: "subscription_not_found" });

    const created = await saveRule({
      userId: user.id,
      type: "renewal_due",
      config: { daysBefore: [7] },
    });
    await expect(
      saveRule({
        userId: stranger.id,
        ruleId: created.ruleId,
        type: "renewal_due",
        enabled: false,
      }),
    ).rejects.toMatchObject({ reason: "rule_not_found" });

    await db.user.delete({ where: { id: user.id } });
    await db.user.delete({ where: { id: stranger.id } });
  });

  it("NotificationAdminError is an Error subclass with a stable reason", () => {
    const error = new NotificationAdminError("invalid_rule_config");
    expect(error).toBeInstanceOf(Error);
    expect(error.reason).toBe("invalid_rule_config");
  });
});
