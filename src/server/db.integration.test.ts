import { describe, expect, it } from "vitest";

import { db } from "./db.js";

const DISABLED = !process.env.TEST_DATABASE_URL;

describe.skipIf(DISABLED)("m1 constraints integration", () => {
  it("rejects an orphan user without any login method", async () => {
    await expect(
      db.user.create({
        data: {
          email: "orphan@example.com",
        },
      }),
    ).rejects.toThrow();
  });

  it("rejects certus link without sync time", async () => {
    await expect(
      db.user.create({
        data: {
          certusSub: "usr-test-orphan-sync",
          certusLinkStatus: "active",
        },
      }),
    ).rejects.toThrow(/users_certus_sync_required/);
  });

  it("rejects suspended user without reason", async () => {
    await expect(
      db.user.create({
        data: {
          certusSub: "usr-test-susp-no-reason",
          lastStatusSyncedAt: new Date(),
          certusLinkStatus: "active",
          status: "suspended",
        },
      }),
    ).rejects.toThrow(/users_suspended_reason/);
  });

  it("rejects a cross-user private vendor reference", async () => {
    const owner = await db.user.create({
      data: {
        certusSub: "usr-test-owner-a",
        lastStatusSyncedAt: new Date(),
        certusLinkStatus: "active",
      },
    });
    const other = await db.user.create({
      data: {
        certusSub: "usr-test-owner-b",
        lastStatusSyncedAt: new Date(),
        certusLinkStatus: "active",
      },
    });
    const privateVendor = await db.vendor.create({
      data: {
        slug: "private-test",
        name: "Private Test",
        category: "other",
        userId: owner.id,
      },
    });

    await expect(
      db.subscription.create({
        data: {
          userId: other.id,
          vendorId: privateVendor.id,
          name: "Cross tenant",
          price: 1,
          currency: "CNY",
          billingCycle: "monthly",
          startedAt: new Date(),
          status: "active",
        },
      }),
    ).rejects.toThrow(/subscription vendor must be a system vendor/);

    await db.vendor.delete({ where: { id: privateVendor.id } });
    await db.user.delete({ where: { id: other.id } });
    await db.user.delete({ where: { id: owner.id } });
  });

  it("allows system vendor references from any tenant", async () => {
    const systemVendor = await db.vendor.create({
      data: {
        slug: "system-test-netflix",
        name: "Netflix Test",
        category: "streaming",
      },
    });
    const user = await db.user.create({
      data: {
        certusSub: "usr-test-system-vendor",
        lastStatusSyncedAt: new Date(),
        certusLinkStatus: "active",
      },
    });

    const sub = await db.subscription.create({
      data: {
        userId: user.id,
        vendorId: systemVendor.id,
        name: "Netflix",
        price: 138,
        currency: "CNY",
        billingCycle: "monthly",
        startedAt: new Date(),
        status: "active",
      },
    });

    expect(sub.id).toBeTruthy();
    await db.subscription.delete({ where: { id: sub.id } });
    await db.vendor.delete({ where: { id: systemVendor.id } });
    await db.user.delete({ where: { id: user.id } });
  });

  it("enforces trial/trialEndsAt pairing and anchor bounds", async () => {
    const user = await db.user.create({
      data: {
        certusSub: "usr-test-constraints",
        lastStatusSyncedAt: new Date(),
        certusLinkStatus: "active",
      },
    });

    await expect(
      db.subscription.create({
        data: {
          userId: user.id,
          name: "Trial without ends",
          price: 10,
          currency: "CNY",
          billingCycle: "monthly",
          startedAt: new Date(),
          status: "trial",
        },
      }),
    ).rejects.toThrow(/subscriptions_trial_requires_ends/);

    await expect(
      db.subscription.create({
        data: {
          userId: user.id,
          name: "Bad anchor",
          price: 10,
          currency: "CNY",
          billingCycle: "monthly",
          startedAt: new Date(),
          status: "active",
          anchorDay: 32,
        },
      }),
    ).rejects.toThrow(/subscriptions_anchor_day_bounds/);

    await db.user.delete({ where: { id: user.id } });
  });

  it("rejects certus cipher fields on a local session", async () => {
    const user = await db.user.create({
      data: {
        certusSub: "usr-test-session-fields",
        lastStatusSyncedAt: new Date(),
        certusLinkStatus: "active",
      },
    });

    await expect(
      db.session.create({
        data: {
          userId: user.id,
          tokenHash: Buffer.from("a".repeat(32)),
          authMethod: "local",
          idleExpiresAt: new Date(Date.now() + 60_000),
          absoluteExpiresAt: new Date(Date.now() + 3600_000),
          lastSeenAt: new Date(),
          authTime: new Date(),
          certusSid: "should-not-exist",
        },
      }),
    ).rejects.toThrow(/sessions_certus_fields/);

    await db.user.delete({ where: { id: user.id } });
  });
});
