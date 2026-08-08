import { describe, expect, it } from "vitest";

import { db } from "@/server/db";
import { nextBillingOnOrAfter } from "./cycle";
import { localToday } from "./local-date";
import { runRenewals } from "./renewals";
import {
  changeSubscriptionStatus,
  createPrivateVendor,
  createSubscription,
  deletePrivateVendor,
  deleteSubscription,
  getSubscription,
  listSubscriptions,
  TenantError,
  updatePrivateVendor,
  updateSubscription,
} from "./subscriptions";

const DISABLED = !process.env.TEST_DATABASE_URL;

function uniqueSub(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function makeUser(sub: string) {
  return db.user.create({
    data: {
      certusSub: sub,
      certusLinkStatus: "active",
      lastStatusSyncedAt: new Date(),
    },
  });
}

describe.skipIf(DISABLED)("tenant-safe subscription CRUD", () => {
  it("creates a subscription with derived nextBillingAt and reads it back", async () => {
    const user = await makeUser(uniqueSub("sub-crud-1"));
    const created = await createSubscription(user.id, {
      name: "Netflix",
      price: 138,
      currency: "CNY",
      billingCycle: "monthly",
      startedAt: new Date("2026-01-31T00:00:00Z"),
      anchorDay: 31,
      status: "active",
      tags: ["streaming"],
    });
    expect(created.nextBillingAt).toEqual(new Date("2026-02-28T00:00:00Z"));
    expect(created.userId).toBe(user.id);

    const listed = await listSubscriptions(user.id);
    expect(listed.some((s) => s.id === created.id)).toBe(true);

    const fetched = await getSubscription(user.id, created.id);
    expect(fetched.name).toBe("Netflix");

    await db.subscription.delete({ where: { id: created.id } });
    await db.user.delete({ where: { id: user.id } });
  });

  it("cross-tenant reads return 404 (not found)", async () => {
    const owner = await makeUser(uniqueSub("sub-cross-a"));
    const other = await makeUser(uniqueSub("sub-cross-b"));
    const created = await createSubscription(owner.id, {
      name: "Claude",
      price: 20,
      currency: "USD",
      billingCycle: "monthly",
      startedAt: new Date("2026-01-01T00:00:00Z"),
      status: "active",
    });

    await expect(getSubscription(other.id, created.id)).rejects.toThrow(
      TenantError,
    );
    await expect(
      updateSubscription(other.id, created.id, { name: "Hacked" }),
    ).rejects.toThrow(TenantError);
    await expect(deleteSubscription(other.id, created.id)).rejects.toThrow(
      TenantError,
    );

    // Owner still intact.
    expect((await getSubscription(owner.id, created.id)).name).toBe("Claude");

    await db.subscription.delete({ where: { id: created.id } });
    await db.user.delete({ where: { id: owner.id } });
    await db.user.delete({ where: { id: other.id } });
  });

  it("rejects invalid inputs at the service boundary", async () => {
    const user = await makeUser(uniqueSub("sub-invalid"));
    const base = {
      name: "X",
      price: 10,
      currency: "CNY",
      billingCycle: "monthly" as const,
      startedAt: new Date("2026-01-01T00:00:00Z"),
      status: "active" as const,
    };

    await expect(
      createSubscription(user.id, { ...base, currency: "CN" }),
    ).rejects.toThrow(/currency/);
    await expect(
      createSubscription(user.id, { ...base, price: -1 }),
    ).rejects.toThrow(/price/);
    await expect(
      createSubscription(user.id, { ...base, anchorDay: 32 }),
    ).rejects.toThrow(/anchorDay/);
    await expect(
      createSubscription(user.id, {
        ...base,
        status: "trial",
        trialEndsAt: null,
      }),
    ).rejects.toThrow(/trial/);
    await expect(
      createSubscription(user.id, { ...base, billingCycle: "custom" }),
    ).rejects.toThrow(/cycleDays/);

    await db.user.delete({ where: { id: user.id } });
  });

  it("private vendors are tenant-scoped; system vendors readable by all", async () => {
    const a = await makeUser(uniqueSub("vendor-a"));
    const b = await makeUser(uniqueSub("vendor-b"));

    const privateVendor = await createPrivateVendor(a.id, {
      slug: "my-tool",
      name: "My Tool",
      category: "dev_tool",
    });

    // b cannot update/delete a's private vendor
    await expect(
      updatePrivateVendor(b.id, privateVendor.id, { name: "Hacked" }),
    ).rejects.toThrow(TenantError);
    await expect(
      deletePrivateVendor(b.id, privateVendor.id),
    ).rejects.toThrow(TenantError);

    // b cannot create a subscription referencing a's private vendor
    await expect(
      createSubscription(b.id, {
        name: "Leak",
        price: 1,
        currency: "CNY",
        billingCycle: "monthly",
        startedAt: new Date("2026-01-01T00:00:00Z"),
        status: "active",
        vendorId: privateVendor.id,
      }),
    ).rejects.toThrow(TenantError);

    // system vendor usable by any tenant
    const systemVendor = await db.vendor.create({
      data: { slug: "netflix-sys", name: "Netflix", category: "streaming" },
    });
    const sub = await createSubscription(b.id, {
      name: "Netflix",
      price: 138,
      currency: "CNY",
      billingCycle: "monthly",
      startedAt: new Date("2026-01-01T00:00:00Z"),
      status: "active",
      vendorId: systemVendor.id,
    });
    expect(sub.vendorId).toBe(systemVendor.id);

    await db.subscription.delete({ where: { id: sub.id } });
    await db.vendor.delete({ where: { id: systemVendor.id } });
    await db.vendor.delete({ where: { id: privateVendor.id } });
    await db.user.delete({ where: { id: a.id } });
    await db.user.delete({ where: { id: b.id } });
  });
});

describe.skipIf(DISABLED)("nextBillingAt semantics (#104)", () => {
  it("persists derived anchorDay on create; unrelated edits never recalculate", async () => {
    const user = await makeUser(uniqueSub("nb-1"));
    const sub = await createSubscription(user.id, {
      name: "Netflix",
      price: 138,
      currency: "CNY",
      billingCycle: "monthly",
      // next=2026-08-31 落在真实当前之后：并发 renewals 不会为其建账，清理无 RESTRICT
      startedAt: new Date("2026-07-31T00:00:00Z"),
      status: "active",
    });
    // 锚定日从 startedAt 固化（旧 bug：每段从 cursor 反推，1/31 会退化成 28 号）
    expect(sub.anchorDay).toBe(31);
    expect(sub.nextBillingAt).toEqual(new Date("2026-08-31T00:00:00Z"));

    // 已推进的 next 被重置回落是旧 bug 的直接后果：改 notes 不得动日期
    await db.subscription.update({
      where: { id: sub.id },
      data: { nextBillingAt: new Date("2026-12-31T00:00:00Z") },
    });
    const updated = await updateSubscription(user.id, sub.id, { notes: "只改备注" });
    expect(updated.nextBillingAt).toEqual(new Date("2026-12-31T00:00:00Z"));

    await db.subscription.delete({ where: { id: sub.id } });
    await db.user.delete({ where: { id: user.id } });
  });

  it("recomputes to the next future period only when cycle fields change", async () => {
    const user = await makeUser(uniqueSub("nb-2"));
    const startedAt = new Date(); // next 在未来：并发 renewals 不会为其建账
    const sub = await createSubscription(user.id, {
      name: "Claude",
      price: 20,
      currency: "USD",
      billingCycle: "monthly",
      startedAt,
      status: "active",
    });
    const updated = await updateSubscription(user.id, sub.id, { billingCycle: "yearly" });
    const expected = nextBillingOnOrAfter(new Date(), startedAt, "yearly", {
      anchorDay: startedAt.getUTCDate(),
    });
    expect(updated.nextBillingAt).toEqual(expected);
    // 重算绝不落过去 —— 落过去会被 renewals 追补成伪造 pending
    expect(updated.nextBillingAt!.getTime()).toBeGreaterThanOrEqual(
      localToday(new Date(), "Asia/Shanghai").getTime(),
    );

    await db.subscription.delete({ where: { id: sub.id } });
    await db.user.delete({ where: { id: user.id } });
  });

  it("resume from pause advances to the next future period; renewals backfills nothing", async () => {
    const user = await makeUser(uniqueSub("nb-3"));
    const sub = await createSubscription(user.id, {
      name: "Paused",
      price: 50,
      currency: "CNY",
      billingCycle: "monthly",
      startedAt: new Date("2026-01-15T00:00:00Z"),
      status: "paused",
    });
    await changeSubscriptionStatus(user.id, sub.id, "active");
    const resumed = await getSubscription(user.id, sub.id);
    expect(resumed.nextBillingAt).not.toBeNull();
    expect(resumed.nextBillingAt!.getUTCDate()).toBe(15);
    expect(resumed.nextBillingAt!.getTime()).toBeGreaterThanOrEqual(
      localToday(new Date(), "Asia/Shanghai").getTime(),
    );

    // 恢复后 renewals 不应追补任何 pending（旧行为：落过去的 next 触发批量伪造）
    await runRenewals();
    const pendings = await db.billingRecord.findMany({
      where: { userId: user.id, subscriptionId: sub.id },
    });
    expect(pendings.length).toBe(0);

    await db.subscription.delete({ where: { id: sub.id } });
    await db.user.delete({ where: { id: user.id } });
  });
});
