import { describe, expect, it } from "vitest";

import { db } from "@/server/db";

import {
  ConnectionError,
  createProviderConnection,
  revokeProviderConnection,
} from "./connections";
import { createManualQuota, updateManualUsage } from "./manual";
import { decryptConnectionCredential } from "./sync";

const DISABLED = !process.env.TEST_DATABASE_URL;

function unique(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function makeUser(sub: string) {
  return db.user.create({
    data: { certusSub: sub, certusLinkStatus: "active", lastStatusSyncedAt: new Date() },
  });
}

async function makeSubscription(userId: string, name: string) {
  return db.subscription.create({
    data: {
      userId,
      name,
      status: "active",
      price: 10,
      currency: "CNY",
      billingCycle: "monthly",
      startedAt: new Date("2026-01-01T00:00:00Z"),
    },
  });
}

async function cleanup(userId: string) {
  await db.user.delete({ where: { id: userId } });
}

describe.skipIf(DISABLED)("provider connections (#71)", () => {
  it("creates a connection whose credential round-trips through the envelope", async () => {
    const user = await makeUser(unique("conn-1"));
    const apiKey = `sk-test-${unique("key")}`;
    const { connectionId } = await createProviderConnection({
      userId: user.id,
      providerId: "deepseek",
      displayName: "我的 DeepSeek",
      apiKey,
    });

    const conn = await db.providerConnection.findUniqueOrThrow({
      where: { id: connectionId },
    });
    expect(conn.status).toBe("active");
    expect(conn.nextSyncAt).not.toBeNull();
    expect(decryptConnectionCredential(conn).secret).toBe(apiKey);
    // 明文不落库：cipher 不等于原文，iv/tag 列齐备
    expect(Buffer.from(conn.credentialCipher).toString("utf8")).not.toContain(apiKey);
    expect(conn.credentialIv.length).toBeGreaterThan(0);
    expect(conn.credentialTag.length).toBeGreaterThan(0);

    await cleanup(user.id);
  });

  it("rejects an unknown provider", async () => {
    const user = await makeUser(unique("conn-2"));
    await expect(
      createProviderConnection({
        userId: user.id,
        providerId: "no-such-provider",
        displayName: "x",
        apiKey: "sk-12345678",
      }),
    ).rejects.toThrow(ConnectionError);
    await cleanup(user.id);
  });

  it("revoke disables the connection, revokes bindings, and falls back the authoritative source", async () => {
    const user = await makeUser(unique("conn-3"));
    const sub = await makeSubscription(user.id, "DeepSeek");
    const { connectionId } = await createProviderConnection({
      userId: user.id,
      providerId: "deepseek",
      displayName: "ds",
      apiKey: "sk-12345678",
    });
    const { quotaId } = await createManualQuota({
      userId: user.id,
      subscriptionId: sub.id,
      kind: "balance",
      metric: "credit",
      unit: "CNY",
      remainingValue: 100,
      resetCycle: "never",
    });
    await updateManualUsage({ userId: user.id, quotaId, remainingValue: 42 });

    const providerBinding = await db.usageBinding.create({
      data: {
        userId: user.id,
        quotaId,
        source: "provider",
        sourceKey: "balance",
        connectionId,
      },
    });
    const manualBinding = await db.usageBinding.findFirstOrThrow({
      where: { quotaId, source: "manual" },
    });
    await db.usageQuota.update({
      where: { id: quotaId },
      data: { authoritativeBindingId: providerBinding.id },
    });

    await revokeProviderConnection({ userId: user.id, connectionId });

    const conn = await db.providerConnection.findUniqueOrThrow({
      where: { id: connectionId },
    });
    expect(conn.status).toBe("disabled");
    const revoked = await db.usageBinding.findUniqueOrThrow({
      where: { id: providerBinding.id },
    });
    expect(revoked.status).toBe("revoked");

    const quota = await db.usageQuota.findUniqueOrThrow({ where: { id: quotaId } });
    expect(quota.authoritativeBindingId).toBe(manualBinding.id);
    expect(quota.remainingValue?.toString()).toBe("42");

    await cleanup(user.id);
  });

  it("clears the authoritative binding when no active candidate remains", async () => {
    const user = await makeUser(unique("conn-4"));
    const sub = await makeSubscription(user.id, "DeepSeek");
    const { connectionId } = await createProviderConnection({
      userId: user.id,
      providerId: "deepseek",
      displayName: "ds",
      apiKey: "sk-12345678",
    });
    const { quotaId } = await createManualQuota({
      userId: user.id,
      subscriptionId: sub.id,
      kind: "balance",
      metric: "credit",
      unit: "CNY",
      remainingValue: 10,
      resetCycle: "never",
    });
    await db.usageBinding.updateMany({
      where: { quotaId, source: "manual" },
      data: { status: "revoked" },
    });
    const providerBinding = await db.usageBinding.create({
      data: { userId: user.id, quotaId, source: "provider", sourceKey: "balance", connectionId },
    });
    await db.usageQuota.update({
      where: { id: quotaId },
      data: { authoritativeBindingId: providerBinding.id },
    });

    await revokeProviderConnection({ userId: user.id, connectionId });

    const quota = await db.usageQuota.findUniqueOrThrow({ where: { id: quotaId } });
    expect(quota.authoritativeBindingId).toBeNull();
    // 数值不清空：kind CHECK（§6.2）不允许，历史读数是事实
    expect(quota.remainingValue?.toString()).toBe("10");

    await cleanup(user.id);
  });

  it("refuses to revoke another user's connection", async () => {
    const owner = await makeUser(unique("conn-5a"));
    const other = await makeUser(unique("conn-5b"));
    const { connectionId } = await createProviderConnection({
      userId: owner.id,
      providerId: "deepseek",
      displayName: "ds",
      apiKey: "sk-12345678",
    });
    await expect(
      revokeProviderConnection({ userId: other.id, connectionId }),
    ).rejects.toThrow(ConnectionError);
    await cleanup(owner.id);
    await cleanup(other.id);
  });
});
