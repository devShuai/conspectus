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

describe.skipIf(DISABLED)("provider connections", () => {
  it("creates connection + quota + binding in one transaction, credential round-trips", async () => {
    const user = await makeUser(unique("conn-1"));
    const sub = await makeSubscription(user.id, "DeepSeek");
    const apiKey = `sk-test-${unique("key")}`;
    const { connectionId, quotaId, bindingId } = await createProviderConnection({
      userId: user.id,
      providerId: "deepseek",
      displayName: "我的 DeepSeek",
      apiKey,
      subscriptionId: sub.id,
      unit: "CNY",
      scopes: ["kimi:international"],
    });

    const conn = await db.providerConnection.findUniqueOrThrow({
      where: { id: connectionId },
    });
    expect(conn.status).toBe("active");
    expect(conn.nextSyncAt).not.toBeNull();
    expect(conn.scopes).toEqual(["kimi:international"]);

    // 凭证分列（#109）：cipher 不含原文，iv/tag 齐备，按列解密回原文，scopes 透传（#89）
    expect(Buffer.from(conn.credentialCipher).toString("utf8")).not.toContain(apiKey);
    expect(conn.credentialIv.length).toBeGreaterThan(0);
    expect(conn.credentialTag.length).toBeGreaterThan(0);
    const decrypted = decryptConnectionCredential(conn);
    expect(decrypted.secret).toBe(apiKey);
    expect(decrypted.scopes).toEqual(["kimi:international"]);

    // quota（balance/credit，CHECK 要求 remainingValue 非空）+ provider binding + 首个即权威
    const quota = await db.usageQuota.findUniqueOrThrow({ where: { id: quotaId } });
    expect(quota.kind).toBe("balance");
    expect(quota.metric).toBe("credit");
    expect(quota.authoritativeBindingId).toBe(bindingId);
    const binding = await db.usageBinding.findUniqueOrThrow({ where: { id: bindingId } });
    expect(binding.source).toBe("provider");
    expect(binding.sourceKey).toBe("credit");
    expect(binding.connectionId).toBe(connectionId);

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
        subscriptionId: "00000000-0000-0000-0000-000000000000",
        unit: "CNY",
      }),
    ).rejects.toThrow(ConnectionError);
    await cleanup(user.id);
  });

  it("creates both MiniMax Coding Plan quotas and provider bindings atomically", async () => {
    const user = await makeUser(unique("conn-minimax"));
    const sub = await makeSubscription(user.id, "MiniMax Coding Plan");
    const result = await createProviderConnection({
      userId: user.id,
      providerId: "minimax-coding-plan",
      displayName: "MiniMax Coding Plan",
      apiKey: "sk-cp-test-12345678",
      subscriptionId: sub.id,
      unit: "CNY",
    });

    expect(result.quotaIds).toHaveLength(2);
    expect(result.bindingIds).toHaveLength(2);
    const quotas = await db.usageQuota.findMany({
      where: { id: { in: result.quotaIds } },
      orderBy: { metric: "asc" },
    });
    expect(quotas.map((quota) => quota.metric)).toEqual(["minimax:5h", "minimax:weekly"]);
    expect(quotas.every((quota) => quota.kind === "quota" && quota.unit === "req")).toBe(true);
    const bindings = await db.usageBinding.findMany({
      where: { id: { in: result.bindingIds } },
      orderBy: { sourceKey: "asc" },
    });
    expect(bindings.map((binding) => binding.sourceKey)).toEqual([
      "minimax:5h",
      "minimax:weekly",
    ]);
    expect(bindings.every((binding) => binding.connectionId === result.connectionId)).toBe(true);
    expect(quotas.map((quota) => quota.authoritativeBindingId).sort()).toEqual(
      [...result.bindingIds].sort(),
    );

    await cleanup(user.id);
  });

  it("reconnect finds the existing quota and points the binding at the new connection", async () => {
    const user = await makeUser(unique("conn-2b"));
    const sub = await makeSubscription(user.id, "DeepSeek");
    const { quotaId } = await createManualQuota({
      userId: user.id,
      subscriptionId: sub.id,
      kind: "balance",
      metric: "credit",
      unit: "CNY",
      remainingValue: 100,
      resetCycle: "never",
    });

    const result = await createProviderConnection({
      userId: user.id,
      providerId: "deepseek",
      displayName: "ds",
      apiKey: "sk-12345678",
      subscriptionId: sub.id,
      unit: "CNY",
    });
    // find-or-create：同一条 quota，不另建；手动 quota 数值不动
    expect(result.quotaId).toBe(quotaId);
    const quota = await db.usageQuota.findUniqueOrThrow({ where: { id: quotaId } });
    expect(quota.remainingValue?.toString()).toBe("100");
    // 已有 manual 权威，provider binding 不抢（§6.2 首个 binding 才决定权威）
    const manualBinding = await db.usageBinding.findFirstOrThrow({
      where: { quotaId, source: "manual" },
    });
    expect(quota.authoritativeBindingId).toBe(manualBinding.id);

    await cleanup(user.id);
  });

  it("revoke disables the connection, revokes bindings, and falls back the authoritative source", async () => {
    const user = await makeUser(unique("conn-3"));
    const sub = await makeSubscription(user.id, "DeepSeek");
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

    const { connectionId, bindingId: providerBindingId } = await createProviderConnection({
      userId: user.id,
      providerId: "deepseek",
      displayName: "ds",
      apiKey: "sk-12345678",
      subscriptionId: sub.id,
      unit: "CNY",
    });
    const manualBinding = await db.usageBinding.findFirstOrThrow({
      where: { quotaId, source: "manual" },
    });
    await db.usageQuota.update({
      where: { id: quotaId },
      data: { authoritativeBindingId: providerBindingId },
    });

    await revokeProviderConnection({ userId: user.id, connectionId });

    const conn = await db.providerConnection.findUniqueOrThrow({
      where: { id: connectionId },
    });
    expect(conn.status).toBe("disabled");
    const revoked = await db.usageBinding.findUniqueOrThrow({
      where: { id: providerBindingId },
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
    const { quotaId } = await createManualQuota({
      userId: user.id,
      subscriptionId: sub.id,
      kind: "balance",
      metric: "credit",
      unit: "CNY",
      remainingValue: 10,
      resetCycle: "never",
    });
    const { connectionId, bindingId: providerBindingId } = await createProviderConnection({
      userId: user.id,
      providerId: "deepseek",
      displayName: "ds",
      apiKey: "sk-12345678",
      subscriptionId: sub.id,
      unit: "CNY",
    });
    await db.usageBinding.updateMany({
      where: { quotaId, source: "manual" },
      data: { status: "revoked" },
    });
    await db.usageQuota.update({
      where: { id: quotaId },
      data: { authoritativeBindingId: providerBindingId },
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
    const sub = await makeSubscription(owner.id, "DeepSeek");
    const { connectionId } = await createProviderConnection({
      userId: owner.id,
      providerId: "deepseek",
      displayName: "ds",
      apiKey: "sk-12345678",
      subscriptionId: sub.id,
      unit: "CNY",
    });
    await expect(
      revokeProviderConnection({ userId: other.id, connectionId }),
    ).rejects.toThrow(ConnectionError);
    await cleanup(owner.id);
    await cleanup(other.id);
  });
});
