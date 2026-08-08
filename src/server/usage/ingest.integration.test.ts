import { describe, expect, it } from "vitest";

import { db } from "@/server/db";
import { ingestReadings } from "./ingest";
import { switchAuthoritativeBinding } from "./authority";
import { UsageReadingSchema } from "./reading";

const DISABLED = !process.env.TEST_DATABASE_URL;

function uniqueSub(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function setupUser() {
  return db.user.create({
    data: {
      certusSub: uniqueSub("ingest"),
      certusLinkStatus: "active",
      lastStatusSyncedAt: new Date(),
    },
  });
}

async function setupQuota(userId: string, kind: "quota" | "counter" | "balance") {
  const sub = await db.subscription.create({
    data: {
      userId,
      name: "T",
      price: 10,
      currency: "CNY",
      billingCycle: "monthly",
      startedAt: new Date("2026-01-01T00:00:00Z"),
      status: "active",
    },
  });
  const quota = await db.usageQuota.create({
    data: {
      userId,
      subscriptionId: sub.id,
      kind,
      metric: "requests",
      unit: "req",
      limitValue: kind === "quota" ? 100 : null,
      usedValue: kind === "quota" || kind === "counter" ? 0 : null,
      remainingValue: kind === "balance" ? 50 : null,
      resetCycle: kind === "balance" ? "never" : "daily",
      periodStart: kind === "quota" ? new Date("2026-01-01T00:00:00Z") : null,
      periodEnd: kind === "quota" ? new Date("2026-01-02T00:00:00Z") : null,
    },
  });
  return { sub, quota };
}

describe.skipIf(DISABLED)("usage ingest", () => {
  it("appends snapshot and updates current value only for authoritative binding", async () => {
    const user = await setupUser();
    const { sub, quota } = await setupQuota(user.id, "quota");
    const manual = await db.usageBinding.create({
      data: { userId: user.id, quotaId: quota.id, source: "manual", sourceKey: "form" },
    });
    await db.usageQuota.update({
      where: { id: quota.id },
      data: { authoritativeBindingId: manual.id },
    });
    const other = await db.usageBinding.create({
      data: { userId: user.id, quotaId: quota.id, source: "provider", sourceKey: "p:req" },
    });

    const reading = UsageReadingSchema.parse({
      bindingId: other.id,
      kind: "quota",
      metric: "requests",
      unit: "req",
      usedValue: "80",
      limitValue: "100",
      capturedAt: "2026-01-01T06:00:00Z",
    });
    const result = await ingestReadings(user.id, [reading]);
    expect(result.accepted).toBe(1);

    // snapshot recorded, but current value unchanged (non-authoritative)
    expect(await db.usageSnapshot.count({ where: { bindingId: other.id } })).toBe(1);
    const quotaAfter = await db.usageQuota.findUnique({ where: { id: quota.id } });
    expect(Number(quotaAfter?.usedValue)).toBe(0);

    // authoritative write updates value
    const authReading = UsageReadingSchema.parse({
      bindingId: manual.id,
      kind: "quota",
      metric: "requests",
      unit: "req",
      usedValue: "42",
      limitValue: "100",
      capturedAt: "2026-01-01T07:00:00Z",
    });
    await ingestReadings(user.id, [authReading]);
    const quotaAfter2 = await db.usageQuota.findUnique({ where: { id: quota.id } });
    expect(Number(quotaAfter2?.usedValue)).toBe(42);
    expect(quotaAfter2?.valueSnapshotId).not.toBeNull();

    await db.usageSnapshot.deleteMany({ where: { userId: user.id } });
    await db.usageBinding.deleteMany({ where: { userId: user.id } });
    await db.usageQuota.deleteMany({ where: { userId: user.id } });
    await db.subscription.deleteMany({ where: { id: sub.id } });
    await db.user.delete({ where: { id: user.id } });
  });

  it("rejects stale reads (older capturedAt never overwrites newer)", async () => {
    const user = await setupUser();
    const { sub, quota } = await setupQuota(user.id, "quota");
    const manual = await db.usageBinding.create({
      data: { userId: user.id, quotaId: quota.id, source: "manual", sourceKey: "form" },
    });
    await db.usageQuota.update({
      where: { id: quota.id },
      data: { authoritativeBindingId: manual.id },
    });

    await ingestReadings(user.id, [
      UsageReadingSchema.parse({
        bindingId: manual.id,
        kind: "quota",
        metric: "requests",
        unit: "req",
        usedValue: "90",
        limitValue: "100",
        capturedAt: "2026-01-01T08:00:00Z",
      }),
    ]);
    // stale older reading
    await ingestReadings(user.id, [
      UsageReadingSchema.parse({
        bindingId: manual.id,
        kind: "quota",
        metric: "requests",
        unit: "req",
        usedValue: "10",
        limitValue: "100",
        capturedAt: "2026-01-01T07:00:00Z",
      }),
    ]);
    const quotaAfter = await db.usageQuota.findUnique({ where: { id: quota.id } });
    expect(Number(quotaAfter?.usedValue)).toBe(90);

    await db.usageSnapshot.deleteMany({ where: { userId: user.id } });
    await db.usageBinding.deleteMany({ where: { userId: user.id } });
    await db.usageQuota.deleteMany({ where: { userId: user.id } });
    await db.subscription.deleteMany({ where: { id: sub.id } });
    await db.user.delete({ where: { id: user.id } });
  });

  it("authority switch rebuilds from target binding snapshot", async () => {
    const user = await setupUser();
    const { sub, quota } = await setupQuota(user.id, "counter");
    const a = await db.usageBinding.create({
      data: { userId: user.id, quotaId: quota.id, source: "manual", sourceKey: "form" },
    });
    const b = await db.usageBinding.create({
      data: { userId: user.id, quotaId: quota.id, source: "local_agent", sourceKey: "cli:x" },
    });
    await db.usageQuota.update({
      where: { id: quota.id },
      data: { authoritativeBindingId: a.id },
    });
    // b has history（用近期时间戳：并发运行的 purge 会清 180 天前的快照，旧日期会 flakes）
    await ingestReadings(user.id, [
      UsageReadingSchema.parse({
        bindingId: b.id,
        kind: "counter",
        metric: "requests",
        unit: "req",
        usedValue: "77",
        capturedAt: new Date(Date.now() - 3_600_000).toISOString(),
      }),
    ]);

    await switchAuthoritativeBinding({
      userId: user.id,
      quotaId: quota.id,
      newBindingId: b.id,
    });
    const quotaAfter = await db.usageQuota.findUnique({ where: { id: quota.id } });
    expect(quotaAfter?.authoritativeBindingId).toBe(b.id);
    expect(Number(quotaAfter?.usedValue)).toBe(77);

    await db.usageSnapshot.deleteMany({ where: { userId: user.id } });
    await db.usageBinding.deleteMany({ where: { userId: user.id } });
    await db.usageQuota.deleteMany({ where: { userId: user.id } });
    await db.subscription.deleteMany({ where: { id: sub.id } });
    await db.user.delete({ where: { id: user.id } });
  });
});

describe.skipIf(DISABLED)("ingest CAS under concurrency (#66)", () => {
  async function authoritativeBinding(userId: string) {
    const { quota } = await setupQuota(userId, "counter");
    const binding = await db.usageBinding.create({
      data: { userId, quotaId: quota.id, source: "local_agent", sourceKey: "c:req", collectorId: "codex" },
    });
    await db.usageQuota.update({
      where: { id: quota.id },
      data: { authoritativeBindingId: binding.id },
    });
    return { quota, binding };
  }

  function reading(bindingId: string, usedValue: string, capturedAt: string) {
    return UsageReadingSchema.parse({
      bindingId,
      kind: "counter",
      metric: "requests",
      unit: "req",
      usedValue,
      capturedAt,
    });
  }

  it("an older reading committed later must not overwrite the newer value", async () => {
    const user = await setupUser();
    const { quota, binding } = await authoritativeBinding(user.id);

    // Both start from the same pre-state, exactly like two devices reporting at
    // once. Under check-then-act both decide "newer" and the later commit wins.
    await Promise.all([
      ingestReadings(user.id, [reading(binding.id, "90", "2026-01-01T09:00:00Z")]),
      ingestReadings(user.id, [reading(binding.id, "10", "2026-01-01T01:00:00Z")]),
    ]);

    const after = await db.usageQuota.findUniqueOrThrow({ where: { id: quota.id } });
    expect(Number(after.usedValue)).toBe(90);
    expect(after.valueCapturedAt?.toISOString()).toBe("2026-01-01T09:00:00.000Z");
    // both readings are still preserved as history
    expect(await db.usageSnapshot.count({ where: { bindingId: binding.id } })).toBe(2);
  });

  it("rejects an older reading arriving after a newer one, in either order", async () => {
    const user = await setupUser();
    const { quota, binding } = await authoritativeBinding(user.id);

    await ingestReadings(user.id, [reading(binding.id, "70", "2026-02-01T12:00:00Z")]);
    await ingestReadings(user.id, [reading(binding.id, "20", "2026-02-01T03:00:00Z")]);

    const after = await db.usageQuota.findUniqueOrThrow({ where: { id: quota.id } });
    expect(Number(after.usedValue)).toBe(70);
  });

  it("is idempotent for a retried identical report", async () => {
    const user = await setupUser();
    const { quota, binding } = await authoritativeBinding(user.id);
    const same = reading(binding.id, "42", "2026-03-01T00:00:00Z");

    const first = await ingestReadings(user.id, [same]);
    const retry = await ingestReadings(user.id, [same]);

    expect(first.accepted).toBe(1);
    // a retry must converge, not be rejected
    expect(retry.accepted).toBe(1);
    expect(await db.usageSnapshot.count({ where: { bindingId: binding.id } })).toBe(1);
    const after = await db.usageQuota.findUniqueOrThrow({ where: { id: quota.id } });
    expect(Number(after.usedValue)).toBe(42);
  });

  it("does not let a non-authoritative binding move the current value", async () => {
    const user = await setupUser();
    const { quota, binding } = await authoritativeBinding(user.id);
    const shadow = await db.usageBinding.create({
      data: {
        userId: user.id,
        quotaId: quota.id,
        source: "provider",
        sourceKey: "p:req",
      },
    });

    await ingestReadings(user.id, [reading(binding.id, "55", "2026-04-01T00:00:00Z")]);
    // newer timestamp, but from a binding that is not authoritative
    await ingestReadings(user.id, [reading(shadow.id, "999", "2026-04-02T00:00:00Z")]);

    const after = await db.usageQuota.findUniqueOrThrow({ where: { id: quota.id } });
    expect(Number(after.usedValue)).toBe(55);
    expect(await db.usageSnapshot.count({ where: { bindingId: shadow.id } })).toBe(1);
  });
});
