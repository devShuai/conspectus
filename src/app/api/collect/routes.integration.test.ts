import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "@/server/db";

/**
 * Route-level coverage for the M4 collect endpoints (#69).
 *
 * These handlers previously had no tests at all, which is how the optional
 * device signature (#67) reached main: §12.3 already listed "撤销单设备后立即
 * 拒绝" as a required scenario, but nothing asserted it.
 *
 * certus introspection is mocked; everything below it (tenancy, signature,
 * nonce, ingest) runs for real against the test database.
 */

const DISABLED = !process.env.TEST_DATABASE_URL;

const introspectCliToken = vi.hoisted(() => vi.fn<() => Promise<string | null>>());
vi.mock("@/server/usage/device-auth", () => ({ introspectCliToken }));

const { POST: registerDevice } = await import("./devices/route");
const { GET: getManifest } = await import("./manifest/route");
const { POST: revokeDevice } = await import("./revoke/route");
const { POST: reportUsage } = await import("./usage/route");

const USAGE_PATH = "/api/collect/usage";

function uniqueSub(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function setupUser() {
  const sub = uniqueSub("routes");
  const user = await db.user.create({
    data: { certusSub: sub, certusLinkStatus: "active", lastStatusSyncedAt: new Date() },
  });
  introspectCliToken.mockResolvedValue(sub);
  return user;
}

function jsonRequest(url: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`http://localhost${url}`, {
    method: "POST",
    headers: { authorization: "Bearer t", "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function signHeaders(
  privateKey: Parameters<typeof sign>[2],
  deviceId: string,
  bodyText: string,
  overrides: Partial<Record<"timestamp" | "nonce", string>> = {},
): Record<string, string> {
  const timestamp = overrides.timestamp ?? new Date().toISOString();
  const nonce = overrides.nonce ?? randomUUID();
  const bodyHash = createHash("sha256").update(bodyText).digest("hex");
  const message = ["POST", USAGE_PATH, timestamp, nonce, bodyHash].join("\n");
  return {
    "x-device-id": deviceId,
    "x-device-signature": sign(null, Buffer.from(message, "utf8"), privateKey).toString("base64"),
    "x-device-timestamp": timestamp,
    "x-device-nonce": nonce,
  };
}

async function makeDevice(userId: string) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const der = publicKey.export({ format: "der", type: "spki" });
  const device = await db.collectorDevice.create({
    data: {
      userId,
      name: "t",
      platform: "t",
      agentVersion: "0",
      publicKey: new Uint8Array(der),
      keyAlgorithm: "Ed25519",
    },
  });
  return { device, privateKey };
}

beforeEach(() => {
  introspectCliToken.mockReset();
});

describe.skipIf(DISABLED)("POST /api/collect/devices", () => {
  it("rejects an unauthenticated caller", async () => {
    introspectCliToken.mockResolvedValue(null);
    const res = await registerDevice(jsonRequest("/api/collect/devices", { publicKey: "AA==" }));
    expect(res.status).toBe(401);
  });

  it("requires a public key", async () => {
    await setupUser();
    const res = await registerDevice(jsonRequest("/api/collect/devices", { name: "x" }));
    expect(res.status).toBe(400);
  });

  it("registers and returns a deviceId", async () => {
    const user = await setupUser();
    const { publicKey } = generateKeyPairSync("ed25519");
    const res = await registerDevice(
      jsonRequest("/api/collect/devices", {
        name: "laptop",
        publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { deviceId: string };
    const stored = await db.collectorDevice.findUniqueOrThrow({ where: { id: body.deviceId } });
    expect(stored.userId).toBe(user.id);
    expect(stored.revokedAt).toBeNull();
  });
});

describe.skipIf(DISABLED)("GET /api/collect/manifest", () => {
  it("returns only this user's active collector bindings and creates nothing", async () => {
    const user = await setupUser();
    const other = await db.user.create({
      data: {
        certusSub: uniqueSub("routes-other"),
        certusLinkStatus: "active",
        lastStatusSyncedAt: new Date(),
      },
    });

    async function makeBinding(ownerId: string, status: "active" | "revoked") {
      const sub = await db.subscription.create({
        data: {
          userId: ownerId,
          name: "s",
          price: 1,
          currency: "CNY",
          billingCycle: "monthly",
          startedAt: new Date("2026-01-01T00:00:00Z"),
          status: "active",
        },
      });
      const quota = await db.usageQuota.create({
        data: {
          userId: ownerId,
          subscriptionId: sub.id,
          kind: "counter",
          metric: `m-${randomUUID().slice(0, 8)}`,
          unit: "req",
          usedValue: 0,
          resetCycle: "never",
        },
      });
      return db.usageBinding.create({
        data: {
          userId: ownerId,
          quotaId: quota.id,
          source: "local_agent",
          sourceKey: "k",
          collectorId: "codex",
          status,
        },
      });
    }

    const mine = await makeBinding(user.id, "active");
    const revoked = await makeBinding(user.id, "revoked");
    const theirs = await makeBinding(other.id, "active");

    // scope the count to this tenant: other test files run in parallel against
    // the same database, so a global count is inherently racy
    const before = await db.usageBinding.count({ where: { userId: user.id } });
    const res = await getManifest(
      new Request("http://localhost/api/collect/manifest", {
        headers: { authorization: "Bearer t" },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { bindings: Array<{ bindingId: string }> };
    const ids = body.bindings.map((b) => b.bindingId);

    expect(ids).toContain(mine.id);
    expect(ids).not.toContain(revoked.id);
    expect(ids).not.toContain(theirs.id);
    // read-only: the manifest never provisions bindings
    expect(await db.usageBinding.count({ where: { userId: user.id } })).toBe(before);
  });
});

describe.skipIf(DISABLED)("POST /api/collect/revoke", () => {
  it("revokes own device and refuses someone else's", async () => {
    const user = await setupUser();
    const { device } = await makeDevice(user.id);

    const ok = await revokeDevice(jsonRequest("/api/collect/revoke", { deviceId: device.id }));
    expect(ok.status).toBe(200);
    const after = await db.collectorDevice.findUniqueOrThrow({ where: { id: device.id } });
    expect(after.revokedAt).not.toBeNull();

    // second revoke is not found (already revoked)
    const again = await revokeDevice(jsonRequest("/api/collect/revoke", { deviceId: device.id }));
    expect(again.status).toBe(404);

    const stranger = await db.user.create({
      data: {
        certusSub: uniqueSub("routes-str"),
        certusLinkStatus: "active",
        lastStatusSyncedAt: new Date(),
      },
    });
    const strangerDevice = await makeDevice(stranger.id);
    const cross = await revokeDevice(
      jsonRequest("/api/collect/revoke", { deviceId: strangerDevice.device.id }),
    );
    expect(cross.status).toBe(404);
    const untouched = await db.collectorDevice.findUniqueOrThrow({
      where: { id: strangerDevice.device.id },
    });
    expect(untouched.revokedAt).toBeNull();
  });
});

describe.skipIf(DISABLED)("POST /api/collect/usage", () => {
  it("refuses an unsigned report and writes no snapshot", async () => {
    const user = await setupUser();
    await makeDevice(user.id);
    const before = await db.usageSnapshot.count({ where: { userId: user.id } });

    const res = await reportUsage(jsonRequest(USAGE_PATH, { readings: [] }));

    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("device_signature_required");
    expect(await db.usageSnapshot.count({ where: { userId: user.id } })).toBe(before);
  });

  it("refuses a revoked device that still signs correctly", async () => {
    const user = await setupUser();
    const { device, privateKey } = await makeDevice(user.id);
    await db.collectorDevice.update({
      where: { id: device.id },
      data: { revokedAt: new Date() },
    });

    const body = JSON.stringify({ readings: [] });
    const res = await reportUsage(
      new Request(`http://localhost${USAGE_PATH}`, {
        method: "POST",
        headers: {
          authorization: "Bearer t",
          "content-type": "application/json",
          ...signHeaders(privateKey, device.id, body),
        },
        body,
      }),
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("device_not_found");
  });

  it("refuses a replayed request", async () => {
    const user = await setupUser();
    const { device, privateKey } = await makeDevice(user.id);
    const body = JSON.stringify({ readings: [] });
    const headers = signHeaders(privateKey, device.id, body);

    const build = () =>
      new Request(`http://localhost${USAGE_PATH}`, {
        method: "POST",
        headers: { authorization: "Bearer t", "content-type": "application/json", ...headers },
        body,
      });

    // empty readings -> 400 from the Zod stage, but the gate has already
    // consumed the nonce
    const first = await reportUsage(build());
    expect(first.status).not.toBe(403);

    const replay = await reportUsage(build());
    expect(replay.status).toBe(403);
    expect((await replay.json()).error).toBe("replayed_nonce");
  });

  it("rejects a reading whose binding belongs to another user", async () => {
    const user = await setupUser();
    const { device, privateKey } = await makeDevice(user.id);

    const stranger = await db.user.create({
      data: {
        certusSub: uniqueSub("routes-bind"),
        certusLinkStatus: "active",
        lastStatusSyncedAt: new Date(),
      },
    });
    const sub = await db.subscription.create({
      data: {
        userId: stranger.id,
        name: "s",
        price: 1,
        currency: "CNY",
        billingCycle: "monthly",
        startedAt: new Date("2026-01-01T00:00:00Z"),
        status: "active",
      },
    });
    const quota = await db.usageQuota.create({
      data: {
        userId: stranger.id,
        subscriptionId: sub.id,
        kind: "counter",
        metric: `m-${randomUUID().slice(0, 8)}`,
        unit: "req",
        usedValue: 0,
        resetCycle: "never",
      },
    });
    const foreign = await db.usageBinding.create({
      data: {
        userId: stranger.id,
        quotaId: quota.id,
        source: "local_agent",
        sourceKey: "k",
        collectorId: "codex",
        status: "active",
      },
    });

    const body = JSON.stringify({
      readings: [
        {
          bindingId: foreign.id,
          kind: "counter",
          metric: "m",
          unit: "req",
          usedValue: "5",
          capturedAt: new Date().toISOString(),
        },
      ],
    });
    const res = await reportUsage(
      new Request(`http://localhost${USAGE_PATH}`, {
        method: "POST",
        headers: {
          authorization: "Bearer t",
          "content-type": "application/json",
          ...signHeaders(privateKey, device.id, body),
        },
        body,
      }),
    );

    // signature is valid, but the binding is not this tenant's：
    // §7.4 一律 202 { accepted, rejected[] }，越权逐条拒绝而不是整包 400
    expect(res.status).toBe(202);
    const result = (await res.json()) as { accepted: number; rejected: unknown[] };
    expect(result.accepted).toBe(0);
    expect(result.rejected.length).toBeGreaterThan(0);
    expect(await db.usageSnapshot.count({ where: { quotaId: quota.id } })).toBe(0);
  });
});
