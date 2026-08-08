import { describe, expect, it } from "vitest";

import { db } from "@/server/db";

import { deleteAccount, DeleteAccountError } from "./delete-account";
import { createReauthTransaction, verifyReauthTransaction } from "./reauth";
import { createPersistentSession } from "./session-db";

const DISABLED = !process.env.TEST_DATABASE_URL;

function unique(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function setupUser() {
  return db.user.create({
    data: {
      certusSub: unique("n113"),
      certusLinkStatus: "active",
      lastStatusSyncedAt: new Date(),
      email: `${unique("n113")}@example.com`,
      emailVerifiedAt: new Date(),
      emailVerificationSource: "local",
    },
  });
}

async function verifiedReauth(userId: string, sessionId: string) {
  const handle = await createReauthTransaction({
    userId,
    sessionId,
    action: "delete_account",
    targetPath: "/me",
  });
  const ok = await verifyReauthTransaction({
    token: handle.token,
    sessionId,
    userId,
    action: "delete_account",
  });
  expect(ok).toBe(true);
  return handle.token;
}

describe.skipIf(DISABLED)("deleteAccount (#113)", () => {
  it("requires matching email and reauth, then cascade-deletes every tenant row", async () => {
    const user = await setupUser();
    const email = user.email!;

    // 邮箱不匹配：reauth 不得被消费，可修正后重试
    const token1 = await verifiedReauth(user.id, "00000000-0000-0000-0000-00000000000a");
    await expect(
      deleteAccount({
        userId: user.id,
        sessionId: "00000000-0000-0000-0000-00000000000a",
        reauthToken: token1,
        confirmEmail: "wrong@example.com",
      }),
    ).rejects.toMatchObject({ code: "email_mismatch" });

    // 缺 reauth
    await expect(
      deleteAccount({
        userId: user.id,
        sessionId: "00000000-0000-0000-0000-00000000000a",
        reauthToken: undefined,
        confirmEmail: email,
      }),
    ).rejects.toMatchObject({ code: "reauth_required" });

    // —— 全量 fixture：每张 tenant 表都铺一行 ——
    const session = await createPersistentSession({
      userId: user.id,
      authMethod: "certus",
      refreshToken: "rt",
    });
    const vendor = await db.vendor.create({
      data: { slug: unique("v"), name: "V", category: "other", userId: user.id },
    });
    const paymentMethod = await db.paymentMethod.create({
      data: { userId: user.id, label: "card", kind: "credit_card" },
    });
    const sub = await db.subscription.create({
      data: {
        userId: user.id,
        vendorId: vendor.id,
        paymentMethodId: paymentMethod.id,
        name: "Plan",
        price: 100,
        currency: "CNY",
        billingCycle: "monthly",
        startedAt: new Date("2026-01-01T00:00:00Z"),
        status: "active",
      },
    });
    const record = await db.billingRecord.create({
      data: {
        userId: user.id,
        subscriptionId: sub.id,
        amount: 100,
        currency: "CNY",
        recordType: "charge",
        billedAt: new Date("2026-08-01"),
        status: "paid",
        source: "manual",
      },
    });
    const conversion = await db.billingConversion.create({
      data: {
        userId: user.id,
        billingRecordId: record.id,
        baseCurrency: "CNY",
        signedAmountInBase: 100,
        fxRate: 1,
        fxDate: new Date("2026-08-01"),
        rateSource: "provider",
      },
    });
    const quota = await db.usageQuota.create({
      data: {
        userId: user.id,
        subscriptionId: sub.id,
        kind: "quota",
        metric: "requests",
        unit: "req",
        limitValue: 100,
        usedValue: 10,
        resetCycle: "monthly",
        periodStart: new Date("2026-08-01T00:00:00Z"),
        periodEnd: new Date("2026-09-01T00:00:00Z"),
      },
    });
    const binding = await db.usageBinding.create({
      data: { userId: user.id, quotaId: quota.id, source: "manual", sourceKey: "form" },
    });
    const device = await db.collectorDevice.create({
      data: {
        userId: user.id,
        name: "Mac",
        platform: "macos",
        agentVersion: "0.1.0",
        publicKey: new Uint8Array(32).fill(1),
      },
    });
    const snapshot = await db.usageSnapshot.create({
      data: {
        userId: user.id,
        quotaId: quota.id,
        bindingId: binding.id,
        deviceId: device.id,
        capturedAt: new Date(),
        kindAtCapture: "quota",
        unitAtCapture: "req",
        value: 10,
      },
    });
    const connection = await db.providerConnection.create({
      data: {
        userId: user.id,
        providerId: "deepseek",
        displayName: "ds",
        credentialKeyId: "v1",
        credentialCipher: new Uint8Array([1]),
        credentialIv: new Uint8Array([2]),
        credentialTag: new Uint8Array([3]),
        scopes: [],
        status: "active",
      },
    });
    const rule = await db.notificationRule.create({
      data: { userId: user.id, type: "balance_low", config: {} },
    });
    const channel = await db.notificationChannel.create({
      data: { userId: user.id, type: "email", mode: "individual" },
    });
    const event = await db.notificationEvent.create({
      data: {
        userId: user.id,
        ruleId: rule.id,
        subjectType: "quota",
        subjectId: quota.id,
        dedupeKey: "k",
        payload: {},
        occurredAt: new Date(),
      },
    });
    const digest = await db.notificationDigest.create({
      data: {
        userId: user.id,
        channelId: channel.id,
        localDate: new Date("2026-08-08"),
        scheduledAt: new Date(),
      },
    });
    const delivery = await db.notificationDelivery.create({
      data: {
        userId: user.id,
        eventId: event.id,
        channelId: channel.id,
        digestId: digest.id,
        scheduledAt: new Date(),
      },
    });
    const armState = await db.notificationArmState.create({
      data: {
        userId: user.id,
        ruleId: rule.id,
        subjectType: "quota",
        subjectId: quota.id,
        armedAt: new Date(),
        armKey: "k1",
      },
    });
    const priceChange = await db.priceChange.create({
      data: {
        userId: user.id,
        subscriptionId: sub.id,
        oldPrice: 90,
        newPrice: 100,
        currency: "CNY",
        detectedBy: "user",
        effectiveAt: new Date("2026-08-01"),
      },
    });
    const rebaseJob = await db.currencyRebaseJob.create({
      data: {
        userId: user.id,
        fromCurrency: "CNY",
        toCurrency: "USD",
        status: "done",
        totalCount: 0,
      },
    });

    // 正确邮箱 + 已验证 reauth（绑定真实 session）
    const token2 = await verifiedReauth(user.id, session.sessionId);
    await deleteAccount({
      userId: user.id,
      sessionId: session.sessionId,
      reauthToken: token2,
      confirmEmail: ` ${email.toUpperCase()} `, // 大小写/空白不敏感
    });

    // 级联硬删除：每张表都无残留（design §9）
    expect(await db.user.findUnique({ where: { id: user.id } })).toBeNull();
    expect(await db.session.findUnique({ where: { id: session.sessionId } })).toBeNull();
    expect(await db.vendor.findUnique({ where: { id: vendor.id } })).toBeNull();
    expect(await db.paymentMethod.findUnique({ where: { id: paymentMethod.id } })).toBeNull();
    expect(await db.subscription.findUnique({ where: { id: sub.id } })).toBeNull();
    expect(await db.billingRecord.findUnique({ where: { id: record.id } })).toBeNull();
    expect(await db.billingConversion.findUnique({ where: { id: conversion.id } })).toBeNull();
    expect(await db.usageQuota.findUnique({ where: { id: quota.id } })).toBeNull();
    expect(await db.usageBinding.findUnique({ where: { id: binding.id } })).toBeNull();
    expect(await db.usageSnapshot.findUnique({ where: { id: snapshot.id } })).toBeNull();
    expect(await db.collectorDevice.findUnique({ where: { id: device.id } })).toBeNull();
    expect(await db.providerConnection.findUnique({ where: { id: connection.id } })).toBeNull();
    expect(await db.notificationRule.findUnique({ where: { id: rule.id } })).toBeNull();
    expect(await db.notificationChannel.findUnique({ where: { id: channel.id } })).toBeNull();
    expect(await db.notificationEvent.findUnique({ where: { id: event.id } })).toBeNull();
    expect(await db.notificationDigest.findUnique({ where: { id: digest.id } })).toBeNull();
    expect(await db.notificationDelivery.findUnique({ where: { id: delivery.id } })).toBeNull();
    expect(await db.notificationArmState.findFirst({ where: { ruleId: rule.id } })).toBeNull();
    expect(await db.priceChange.findUnique({ where: { id: priceChange.id } })).toBeNull();
    expect(await db.currencyRebaseJob.findUnique({ where: { id: rebaseJob.id } })).toBeNull();
    expect(armState).toBeTruthy();
  });

  it("rejects a reauth bound to a different session and keeps the account", async () => {
    const user = await setupUser();
    const sessionA = await createPersistentSession({ userId: user.id, authMethod: "certus" });
    const sessionB = await createPersistentSession({ userId: user.id, authMethod: "certus" });
    const token = await verifiedReauth(user.id, sessionA.sessionId);

    await expect(
      deleteAccount({
        userId: user.id,
        sessionId: sessionB.sessionId,
        reauthToken: token,
        confirmEmail: user.email!,
      }),
    ).rejects.toMatchObject({ code: "reauth_invalid" });
    expect(await db.user.findUnique({ where: { id: user.id } })).not.toBeNull();

    await db.user.delete({ where: { id: user.id } });
  });
});
