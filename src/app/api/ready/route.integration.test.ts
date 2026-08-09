import { beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "@/server/db";

/**
 * /api/ready（#121-2/3）：轻量校验数据库连通 + 迁移版本；deep 探针需要
 * DEPLOY_PROBE_SECRET，60s 缓存与 single-flight 落在 deep_ready_probes 表。
 * certus 上游用 mock；缓存/single-flight 走真实测试库。
 */
const DISABLED = !process.env.TEST_DATABASE_URL;

const fetchClientCapabilities = vi.hoisted(() => vi.fn());
vi.mock("@/server/auth/certus-client-api", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/auth/certus-client-api")>();
  return { ...original, fetchClientCapabilities };
});

const { GET } = await import("./route");

const goodEvidence = {
  httpStatus: 200,
  schemaVersion: 1,
  features: ["client_user_status", "email_verified"],
  introspectionSources: ["conspectus-cli"],
  configRevision: "rev-ready-1",
  hasClientUserStatus: true,
  hasEmailVerifiedFeature: true,
  hasCrossClientIntrospection: true,
  includesCliSource: true,
  cacheControl: "no-store",
};

function deepRequest(secret?: string) {
  return new Request("http://localhost/api/ready?deep=1", {
    headers: secret ? { authorization: `Bearer ${secret}` } : {},
  });
}

describe.skipIf(DISABLED)("ready route (#121)", () => {
  beforeEach(async () => {
    fetchClientCapabilities.mockReset();
    await db.deepReadyProbe.deleteMany();
  });

  it("lightweight ready reports ready when DB is migrated", async () => {
    const response = await GET(new Request("http://localhost/api/ready"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({ status: "ready" });
  });

  it("deep probe without or with wrong deploy secret is 404", async () => {
    expect((await GET(deepRequest())).status).toBe(404);
    expect((await GET(deepRequest("wrong-secret"))).status).toBe(404);
    expect(fetchClientCapabilities).not.toHaveBeenCalled();
  });

  it("deep probe checks capabilities once and serves the second call from cache", async () => {
    fetchClientCapabilities.mockResolvedValue(goodEvidence);
    const secret = process.env.DEPLOY_PROBE_SECRET!;

    const first = await GET(deepRequest(secret));
    expect(first.status).toBe(200);
    const body = await first.json();
    expect(body).toMatchObject({ status: "ready", deep: { ok: true, configRevision: "rev-ready-1" } });
    expect(fetchClientCapabilities).toHaveBeenCalledTimes(1);

    // 60s 内第二次命中数据库缓存行，不再打 certus
    const second = await GET(deepRequest(secret));
    expect(second.status).toBe(200);
    expect(fetchClientCapabilities).toHaveBeenCalledTimes(1);
  });

  it("concurrent deep probes single-flight through the database lease", async () => {
    fetchClientCapabilities.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(goodEvidence), 100)),
    );
    const secret = process.env.DEPLOY_PROBE_SECRET!;

    const [a, b] = await Promise.all([GET(deepRequest(secret)), GET(deepRequest(secret))]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    // 两个并发请求共享同一次上游调用（§5.4：多实例不各自穿透）
    expect(fetchClientCapabilities).toHaveBeenCalledTimes(1);
  });

  it("deep probe failure releases the lease and reports 503", async () => {
    fetchClientCapabilities.mockRejectedValue(new Error("upstream down"));
    const secret = process.env.DEPLOY_PROBE_SECRET!;

    const response = await GET(deepRequest(secret));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      status: "not_ready",
      reason: "capabilities_upstream",
    });

    // 租约已释放：紧接着的探测可以立即重试
    const row = await db.deepReadyProbe.findFirst();
    expect(row?.leaseUntil ?? null).toBeNull();
  });
});
