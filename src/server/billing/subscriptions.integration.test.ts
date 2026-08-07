import { describe, expect, it } from "vitest";

import { db } from "@/server/db";
import {
  createPrivateVendor,
  createSubscription,
  deletePrivateVendor,
  deleteSubscription,
  getSubscription,
  listSubscriptions,
  TenantError,
  updatePrivateVendor,
  updateSubscription,
} from "./subscriptions.js";

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
