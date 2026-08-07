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
    // b has history
    await ingestReadings(user.id, [
      UsageReadingSchema.parse({
        bindingId: b.id,
        kind: "counter",
        metric: "requests",
        unit: "req",
        usedValue: "77",
        capturedAt: "2026-01-01T09:00:00Z",
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
