import { describe, expect, it } from "vitest";

import { db } from "@/server/db";
import { runRenewals } from "./renewals";

const DISABLED = !process.env.TEST_DATABASE_URL;

function uniqueSub(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function setupUser() {
  return db.user.create({
    data: {
      certusSub: uniqueSub("rn"),
      certusLinkStatus: "active",
      lastStatusSyncedAt: new Date(),
    },
  });
}

describe.skipIf(DISABLED)("renewals runner", () => {
  it("creates exactly one pending per due period (idempotent concurrency)", async () => {
    const user = await setupUser();
    const sub = await db.subscription.create({
      data: {
        userId: user.id,
        name: "T",
        price: 10,
        currency: "CNY",
        billingCycle: "monthly",
        startedAt: new Date("2025-12-01T00:00:00Z"),
        nextBillingAt: new Date("2026-01-01T00:00:00Z"),
        status: "active",
        autoRenew: true,
      },
    });

    const [a, b] = await Promise.all([
      runRenewals(new Date("2026-01-15T00:00:00Z")),
      runRenewals(new Date("2026-01-15T00:00:00Z")),
    ]);
    const pendings = await db.billingRecord.count({
      where: { subscriptionId: sub.id, status: "pending" },
    });
    expect(pendings).toBe(1);
    void a;
    void b;

    await db.billingRecord.deleteMany({ where: { subscriptionId: sub.id } });
    await db.subscription.deleteMany({ where: { userId: user.id } });
    await db.user.delete({ where: { id: user.id } });
  });

  it("autoRenew=false → expired with no pending bill", async () => {
    const user = await setupUser();
    const sub = await db.subscription.create({
      data: {
        userId: user.id,
        name: "T",
        price: 10,
        currency: "CNY",
        billingCycle: "monthly",
        startedAt: new Date("2025-12-01T00:00:00Z"),
        nextBillingAt: new Date("2026-01-01T00:00:00Z"),
        status: "active",
        autoRenew: false,
      },
    });

    await runRenewals(new Date("2026-01-15T00:00:00Z"));
    const updated = await db.subscription.findUnique({ where: { id: sub.id } });
    expect(updated?.status).toBe("expired");
    expect(updated?.nextBillingAt).toBeNull();
    expect(
      await db.billingRecord.count({ where: { subscriptionId: sub.id } }),
    ).toBe(0);

    await db.subscription.deleteMany({ where: { userId: user.id } });
    await db.user.delete({ where: { id: user.id } });
  });

  it("trial autoRenew=true → first pending at trialEndsAt then active", async () => {
    const user = await setupUser();
    const sub = await db.subscription.create({
      data: {
        userId: user.id,
        name: "Trial",
        price: 100,
        currency: "CNY",
        billingCycle: "monthly",
        startedAt: new Date("2025-12-01T00:00:00Z"),
        trialEndsAt: new Date("2026-01-10T00:00:00Z"),
        status: "trial",
        autoRenew: true,
      },
    });

    await runRenewals(new Date("2026-01-12T00:00:00Z"));
    const updated = await db.subscription.findUnique({ where: { id: sub.id } });
    expect(updated?.status).toBe("active");
    const pending = await db.billingRecord.findFirst({
      where: { subscriptionId: sub.id, status: "pending" },
    });
    expect(pending?.billedAt).toEqual(new Date("2026-01-10T00:00:00Z"));

    await db.billingRecord.deleteMany({ where: { subscriptionId: sub.id } });
    await db.subscription.deleteMany({ where: { userId: user.id } });
    await db.user.delete({ where: { id: user.id } });
  });

  it("trial autoRenew=false → expired with no bill", async () => {
    const user = await setupUser();
    const sub = await db.subscription.create({
      data: {
        userId: user.id,
        name: "Trial2",
        price: 100,
        currency: "CNY",
        billingCycle: "monthly",
        startedAt: new Date("2025-12-01T00:00:00Z"),
        trialEndsAt: new Date("2026-01-10T00:00:00Z"),
        status: "trial",
        autoRenew: false,
      },
    });

    await runRenewals(new Date("2026-01-12T00:00:00Z"));
    const updated = await db.subscription.findUnique({ where: { id: sub.id } });
    expect(updated?.status).toBe("expired");
    expect(
      await db.billingRecord.count({ where: { subscriptionId: sub.id } }),
    ).toBe(0);

    await db.subscription.deleteMany({ where: { userId: user.id } });
    await db.user.delete({ where: { id: user.id } });
  });
});

describe.skipIf(DISABLED)("renewals regressions (#63, #65)", () => {
  it("keeps trialEndsAt after conversion and expiry (#63)", async () => {
    const user = await setupUser();
    const base = {
      userId: user.id,
      price: 20,
      currency: "CNY",
      billingCycle: "monthly" as const,
      startedAt: new Date("2026-01-01T00:00:00Z"),
      trialEndsAt: new Date("2026-02-01T00:00:00Z"),
      status: "trial" as const,
    };
    const converting = await db.subscription.create({
      data: { ...base, name: "trial-convert", autoRenew: true },
    });
    const expiring = await db.subscription.create({
      data: { ...base, name: "trial-expire", autoRenew: false },
    });

    await runRenewals(new Date("2026-02-02T00:00:00Z"));

    const converted = await db.subscription.findUniqueOrThrow({
      where: { id: converting.id },
    });
    expect(converted.status).toBe("active");
    // the historical fact survives the transition, and still anchors the key
    expect(converted.trialEndsAt?.toISOString().slice(0, 10)).toBe("2026-02-01");

    const expired = await db.subscription.findUniqueOrThrow({
      where: { id: expiring.id },
    });
    expect(expired.status).toBe("expired");
    expect(expired.trialEndsAt?.toISOString().slice(0, 10)).toBe("2026-02-01");
    expect(expired.nextBillingAt).toBeNull();

    const firstCharge = await db.billingRecord.findUnique({
      where: { occurrenceKey: `${converting.id}:2026-02-01` },
    });
    expect(firstCharge?.status).toBe("pending");
    // autoRenew=false must not create a bill
    const noCharge = await db.billingRecord.findUnique({
      where: { occurrenceKey: `${expiring.id}:2026-02-01` },
    });
    expect(noCharge).toBeNull();
  });

  it("converges instead of throwing when the occurrenceKey already exists (#65)", async () => {
    const user = await setupUser();
    const sub = await db.subscription.create({
      data: {
        userId: user.id,
        name: "trial-preexisting",
        price: 30,
        currency: "CNY",
        billingCycle: "monthly",
        startedAt: new Date("2026-03-01T00:00:00Z"),
        trialEndsAt: new Date("2026-04-01T00:00:00Z"),
        status: "trial",
        autoRenew: true,
      },
    });
    // simulate a racing worker that already inserted the first charge
    await db.billingRecord.create({
      data: {
        userId: user.id,
        subscriptionId: sub.id,
        amount: 30,
        currency: "CNY",
        recordType: "charge",
        billedAt: new Date("2026-04-01T00:00:00Z"),
        status: "pending",
        source: "system",
        occurrenceKey: `${sub.id}:2026-04-01`,
      },
    });

    // must not throw: a JS catch cannot rescue an aborted PG transaction, so
    // the insert has to be conflict-tolerant at the SQL level
    await expect(runRenewals(new Date("2026-04-02T00:00:00Z"))).resolves.toBeDefined();

    const after = await db.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(after.status).toBe("active");
    const charges = await db.billingRecord.count({
      where: { subscriptionId: sub.id, recordType: "charge" },
    });
    expect(charges).toBe(1);
  });

  it("decides due-ness in the user's timezone, not UTC (#65)", async () => {
    const tokyo = await db.user.create({
      data: {
        certusSub: uniqueSub("rn-tz"),
        certusLinkStatus: "active",
        lastStatusSyncedAt: new Date(),
        timezone: "Asia/Tokyo", // UTC+9
      },
    });
    const sub = await db.subscription.create({
      data: {
        userId: tokyo.id,
        name: "tz",
        price: 5,
        currency: "JPY",
        billingCycle: "monthly",
        startedAt: new Date("2026-04-05T00:00:00Z"),
        nextBillingAt: new Date("2026-05-05T00:00:00Z"),
        status: "active",
        autoRenew: true,
      },
    });

    // 2026-05-04T20:00Z is already 2026-05-05 in Tokyo -> due there
    await runRenewals(new Date("2026-05-04T20:00:00Z"));
    const charge = await db.billingRecord.findUnique({
      where: { occurrenceKey: `${sub.id}:2026-05-05` },
    });
    expect(charge).not.toBeNull();
  });

  it("trial one_time → first pending with empty period and nextBillingAt=null (#105)", async () => {
    const user = await setupUser();
    const sub = await db.subscription.create({
      data: {
        userId: user.id,
        name: "TrialOneTime",
        price: 300,
        currency: "CNY",
        billingCycle: "one_time",
        startedAt: new Date("2025-12-01T00:00:00Z"),
        trialEndsAt: new Date("2026-01-10T00:00:00Z"),
        status: "trial",
        autoRenew: true,
      },
    });

    await runRenewals(new Date("2026-01-12T00:00:00Z"));
    const updated = await db.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(updated.status).toBe("active");
    // one_time 的 period 与 next 均为空（§7.2）
    expect(updated.nextBillingAt).toBeNull();

    const pending = await db.billingRecord.findFirstOrThrow({
      where: { subscriptionId: sub.id, status: "pending" },
    });
    expect(pending.billedAt).toEqual(new Date("2026-01-10T00:00:00Z"));
    expect(pending.periodStart).toBeNull();
    expect(pending.periodEnd).toBeNull();

    await db.billingRecord.deleteMany({ where: { subscriptionId: sub.id } });
    await db.subscription.deleteMany({ where: { userId: user.id } });
    await db.user.delete({ where: { id: user.id } });
  });
});
