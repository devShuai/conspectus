import { describe, expect, it } from "vitest";

import { db } from "@/server/db";

import { createProviderConnection } from "./connections";
import {
  ProviderError,
  registerProvider,
  syncDueConnections,
  type UsageReadingLike,
} from "./sync";

const DISABLED = !process.env.TEST_DATABASE_URL;

function unique(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

let fetchUsageImpl: () => Promise<UsageReadingLike[]> | UsageReadingLike[] = () => [];

registerProvider({
  id: "fake-sync",
  displayName: "Fake",
  authKind: "api_key",
  async fetchUsage() {
    return fetchUsageImpl();
  },
});

async function setup() {
  const user = await db.user.create({
    data: {
      certusSub: unique("sync"),
      certusLinkStatus: "active",
      lastStatusSyncedAt: new Date(),
    },
  });
  const sub = await db.subscription.create({
    data: {
      userId: user.id,
      name: "DS",
      status: "active",
      price: 10,
      currency: "CNY",
      billingCycle: "monthly",
      startedAt: new Date("2026-01-01T00:00:00Z"),
    },
  });
  const { connectionId, quotaId, bindingId } = await createProviderConnection({
    userId: user.id,
    providerId: "fake-sync",
    displayName: "fake",
    apiKey: "sk-12345678",
    subscriptionId: sub.id,
    unit: "CNY",
  });
  // 测试时钟取 2030：真实时钟的并发 runner（共享测试库）不会把这条连接视为 due，
  // 避免外部 syncDueConnections 干扰 failureCount/nextSyncAt 断言
  const t0 = new Date("2030-01-01T00:00:00Z");
  await db.providerConnection.update({
    where: { id: connectionId },
    data: { nextSyncAt: new Date(t0.getTime() - 1) },
  });
  return { user, sub, connectionId, quotaId, bindingId, t0 };
}

async function cleanup(userId: string) {
  await db.user.delete({ where: { id: userId } });
}

describe.skipIf(DISABLED)("sync runner (#107)", () => {
  it("syncs a reading through to the quota and resets backoff", async () => {
    const { user, connectionId, quotaId, bindingId, t0 } = await setup();
    fetchUsageImpl = () => [
      {
        bindingId,
        kind: "balance",
        metric: "credit",
        unit: "CNY",
        remainingValue: "88.5",
        capturedAt: "2030-01-01T00:00:00Z",
      },
    ];

    const result = await syncDueConnections(t0);
    expect(result.synced).toBe(1);

    const quota = await db.usageQuota.findUniqueOrThrow({ where: { id: quotaId } });
    expect(quota.remainingValue?.toString()).toBe("88.5");
    const conn = await db.providerConnection.findUniqueOrThrow({
      where: { id: connectionId },
    });
    expect(conn.status).toBe("active");
    expect(conn.syncFailureCount).toBe(0);
    expect(conn.nextSyncAt?.getTime()).toBe(t0.getTime() + 6 * 3600_000);
    expect(conn.syncLeaseUntil).toBeNull();

    await cleanup(user.id);
  });

  it("rejects readings whose bindingId does not belong to the connection", async () => {
    const { user, quotaId, t0 } = await setup();
    fetchUsageImpl = () => [
      {
        bindingId: crypto.randomUUID(), // 同用户其他 connection 的 binding 也不得写入
        kind: "balance",
        metric: "credit",
        unit: "CNY",
        remainingValue: "999",
        capturedAt: "2030-01-01T00:00:00Z",
      },
    ];

    await syncDueConnections(t0);
    const quota = await db.usageQuota.findUniqueOrThrow({ where: { id: quotaId } });
    expect(quota.remainingValue?.toString()).toBe("0"); // 未被写入

    await cleanup(user.id);
  });

  it("backs off 1h → 4h → degraded with a 24h probe and persists failureCount", async () => {
    const { user, connectionId, t0 } = await setup();
    fetchUsageImpl = () => {
      throw new ProviderError("network", "upstream boom");
    };

    await syncDueConnections(t0);
    let conn = await db.providerConnection.findUniqueOrThrow({ where: { id: connectionId } });
    expect(conn.syncFailureCount).toBe(1);
    expect(conn.status).toBe("active");
    expect(conn.nextSyncAt?.getTime()).toBe(t0.getTime() + 1 * 3600_000);

    await syncDueConnections(new Date(t0.getTime() + 1 * 3600_000));
    conn = await db.providerConnection.findUniqueOrThrow({ where: { id: connectionId } });
    expect(conn.syncFailureCount).toBe(2);
    expect(conn.nextSyncAt?.getTime()).toBe(t0.getTime() + 1 * 3600_000 + 4 * 3600_000);

    // 第三次仍失败 → degraded，改 24h 探测
    await syncDueConnections(new Date(t0.getTime() + 5 * 3600_000));
    conn = await db.providerConnection.findUniqueOrThrow({ where: { id: connectionId } });
    expect(conn.syncFailureCount).toBe(3);
    expect(conn.status).toBe("degraded");
    expect(conn.nextSyncAt?.getTime()).toBe(
      t0.getTime() + 5 * 3600_000 + 24 * 3600_000,
    );

    await cleanup(user.id);
  });
});
