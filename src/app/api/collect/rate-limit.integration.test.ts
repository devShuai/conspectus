import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { db } from "@/server/db";
import { COLLECT_RATE_LIMITS } from "@/server/auth/rate-limit";

/**
 * #121-6：/api/collect/usage 与 /api/collect/devices 的 IP/用户限流（§9）。
 * 用唯一的 x-forwarded-for 构造独立 IP 桶，把计数直接种到窗口上限，
 * 下一次请求必须 429 且带 Retry-After。不依赖其他测试的计数状态。
 */
const DISABLED = !process.env.TEST_DATABASE_URL;

const introspectCliToken = vi.hoisted(() => vi.fn<() => Promise<string | null>>());
vi.mock("@/server/usage/device-auth", () => ({ introspectCliToken }));

const { POST: registerDevice } = await import("./devices/route");
const { POST: reportUsage } = await import("./usage/route");

function keyHash(scope: string, key: string): string {
  return createHash("sha256").update(scope).update("\0").update(key).digest("hex");
}

/** 把指定 scope+key 的计数种到当前窗口上限（窗口边界与实现同算法）。 */
async function seedCounterAtLimit(scope: string, key: string, limit: number, windowMs: number) {
  const windowStartMs = Math.floor(Date.now() / windowMs) * windowMs;
  await db.rateLimitCounter.create({
    data: {
      scope,
      keyHash: keyHash(scope, key),
      windowStart: new Date(windowStartMs),
      windowEndsAt: new Date(windowStartMs + windowMs),
      attemptCount: limit,
    },
  });
}

async function cleanup(scope: string, key: string) {
  await db.rateLimitCounter.deleteMany({ where: { scope, keyHash: keyHash(scope, key) } });
}

describe.skipIf(DISABLED)("collect endpoint rate limits (#121)", () => {
  it("POST /api/collect/devices returns 429 with Retry-After when IP bucket is full", async () => {
    const ip = `198.51.100.${Math.floor(Math.random() * 200) + 1}`;
    const sub = `rl-devices-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const user = await db.user.create({
      data: { certusSub: sub, certusLinkStatus: "active", lastStatusSyncedAt: new Date() },
    });
    introspectCliToken.mockResolvedValue(sub);
    const rule = COLLECT_RATE_LIMITS.devicesIp;
    await seedCounterAtLimit(rule.scope, ip, rule.limit, rule.windowMs);

    const response = await registerDevice(
      new Request("http://localhost/api/collect/devices", {
        method: "POST",
        headers: {
          authorization: "Bearer t",
          "content-type": "application/json",
          "x-forwarded-for": ip,
        },
        body: JSON.stringify({ publicKey: Buffer.from("k").toString("base64") }),
      }),
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).not.toBeNull();
    await expect(response.json()).resolves.toMatchObject({ error: "rate_limited" });

    await cleanup(rule.scope, ip);
    await db.user.delete({ where: { id: user.id } });
  });

  it("POST /api/collect/usage returns 429 when the per-user bucket is full", async () => {
    const ip = `203.0.113.${Math.floor(Math.random() * 200) + 1}`;
    const sub = `rl-usage-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const user = await db.user.create({
      data: { certusSub: sub, certusLinkStatus: "active", lastStatusSyncedAt: new Date() },
    });
    introspectCliToken.mockResolvedValue(sub);
    const rule = COLLECT_RATE_LIMITS.usageUser;
    await seedCounterAtLimit(rule.scope, user.id, rule.limit, rule.windowMs);

    // 限流在设备签名校验之前生效，无需构造签名
    const response = await reportUsage(
      new Request("http://localhost/api/collect/usage", {
        method: "POST",
        headers: {
          authorization: "Bearer t",
          "content-type": "application/json",
          "x-forwarded-for": ip,
        },
        body: JSON.stringify({ readings: [] }),
      }),
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).not.toBeNull();

    await cleanup(rule.scope, user.id);
    await db.user.delete({ where: { id: user.id } });
  });
});
