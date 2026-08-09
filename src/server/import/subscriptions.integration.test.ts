import { describe, expect, it } from "vitest";

import { db } from "@/server/db";
import { subscriptionCsvChunks } from "@/server/billing/export";
import {
  executeSubscriptionImport,
  previewSubscriptionImport,
} from "./subscriptions";

const DISABLED = !process.env.TEST_DATABASE_URL;

const HEADER =
  "name,vendor,plan,price,currency,billing_cycle,cycle_days,started_at,anchor_day,status,auto_renew,category,payment_method,tags,notes";

function unique(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function makeUser() {
  return db.user.create({
    data: {
      certusSub: unique("import-sub"),
      certusLinkStatus: "active",
      lastStatusSyncedAt: new Date(),
    },
  });
}

async function exportText(userId: string): Promise<string> {
  let text = "";
  for await (const chunk of subscriptionCsvChunks(userId)) text += chunk;
  return text;
}

async function subCount(userId: string): Promise<number> {
  return db.subscription.count({ where: { userId } });
}

describe.skipIf(DISABLED)("CSV 导入三步走 (#120)", () => {
  it("preview 逐行校验并分类新建/冲突（name+vendor 大小写不敏感）", async () => {
    const user = await makeUser();
    const vendor = await db.vendor.create({
      data: { slug: unique("nf"), name: "Netflix", category: "streaming", userId: user.id },
    });
    await db.subscription.create({
      data: {
        userId: user.id,
        vendorId: vendor.id,
        name: "Netflix",
        status: "active",
        price: 138,
        currency: "CNY",
        billingCycle: "monthly",
        startedAt: new Date("2026-01-01T00:00:00Z"),
      },
    });

    const csv = [
      HEADER,
      "netflix,NETFLIX,,138,CNY,monthly,,2026-01-01,,active,true,streaming,,,",
      "Spotify,,,15,USD,monthly,,2026-02-01,,active,true,music,,,",
      ",,,15,USD,monthly,,2026-02-01,,active,true,,,,",
      "Bad Price,,,abc,USD,monthly,,2026-02-01,,active,true,,,,",
      "Bad Status,,,15,USD,monthly,,2026-02-01,,bogus,true,,,,",
      ",,,,,,,,,,,,,,",
    ].join("\r\n");

    const preview = await previewSubscriptionImport(user.id, csv, "skip");
    expect(preview.summary.total).toBe(5); // 全空行被跳过
    expect(preview.summary.invalid).toBe(3);
    expect(preview.summary.skip).toBe(1); // netflix/NETFLIX 命中冲突 → skip
    expect(preview.summary.create).toBe(1); // Spotify 新建
    const conflictRow = preview.rows.find((r) => r.name === "netflix");
    expect(conflictRow?.existingId).not.toBeNull();
    const spotify = preview.rows.find((r) => r.name === "Spotify");
    expect(spotify?.action).toBe("create");
    expect(spotify?.willCreateVendor).toBe(false); // vendor 列空 = 无 vendor
    expect(preview.rows.find((r) => r.name === "Bad Price")?.errors[0]).toContain("price");
    expect(preview.rows.find((r) => r.name === "Bad Status")?.errors[0]).toContain("status");

    await db.user.delete({ where: { id: user.id } });
  });

  it("preview 对新建行强制必填四要素，trial 状态明确报错", async () => {
    const user = await makeUser();
    const csv = [
      HEADER,
      "No Price,,,,USD,monthly,,2026-02-01,,active,true,,,,",
      "Trial,,,0,USD,monthly,,2026-02-01,,trial,true,,,,",
    ].join("\r\n");
    const preview = await previewSubscriptionImport(user.id, csv, "skip");
    expect(preview.summary.invalid).toBe(2);
    expect(preview.rows[0].errors.join()).toContain("price");
    expect(preview.rows[1].errors.join()).toContain("trial");
    await db.user.delete({ where: { id: user.id } });
  });

  it("confirm skip：幂等，重复确认不产生重复行", async () => {
    const user = await makeUser();
    const csv = [
      HEADER,
      `${unique("SkipMe")},Acme,,10,USD,monthly,,2026-01-01,,active,true,cloud,,,`,
    ].join("\r\n");

    const first = await executeSubscriptionImport(user.id, csv, "skip");
    expect(first).toMatchObject({ created: 1, updated: 0, skipped: 0, failed: [] });
    expect(await subCount(user.id)).toBe(1);
    // 首次导入顺带新建了私有 Vendor（category 来自 CSV）
    const vendor = await db.vendor.findFirst({ where: { userId: user.id, name: "Acme" } });
    expect(vendor?.category).toBe("cloud");

    const second = await executeSubscriptionImport(user.id, csv, "skip");
    expect(second).toMatchObject({ created: 0, updated: 0, skipped: 1, failed: [] });
    expect(await subCount(user.id)).toBe(1); // 终态不变

    await db.user.delete({ where: { id: user.id } });
  });

  it("confirm update：只覆盖 CSV 出现的列", async () => {
    const user = await makeUser();
    const name = unique("Upd");
    const sub = await db.subscription.create({
      data: {
        userId: user.id,
        name,
        planName: "Pro",
        status: "active",
        price: 10,
        currency: "USD",
        billingCycle: "monthly",
        anchorDay: 5,
        startedAt: new Date("2026-01-05T00:00:00Z"),
        notes: "keep-me",
      },
    });
    // 只有 name,price 两列：price 被覆盖，plan/notes/anchorDay 原样保留
    const csv = ["name,price", `${name.toUpperCase()},42`].join("\r\n");

    const result = await executeSubscriptionImport(user.id, csv, "update");
    expect(result).toMatchObject({ created: 0, updated: 1, skipped: 0, failed: [] });

    const after = await db.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(Number(after.price)).toBe(42);
    expect(after.planName).toBe("Pro");
    expect(after.notes).toBe("keep-me");
    expect(after.anchorDay).toBe(5);
    expect(after.name).toBe(name.toUpperCase()); // name 列出现，大小写按 CSV 落库

    // 幂等：再次确认仍是 update，不产生新行
    const again = await executeSubscriptionImport(user.id, csv, "update");
    expect(again).toMatchObject({ created: 0, updated: 1, skipped: 0, failed: [] });
    expect(await subCount(user.id)).toBe(1);

    await db.user.delete({ where: { id: user.id } });
  });

  it("confirm duplicate：冲突仍新建；重复确认因完全一致而跳过", async () => {
    const user = await makeUser();
    const name = unique("Dup");
    const csv = [
      HEADER,
      `${name},,,10,USD,monthly,,2026-01-01,,active,true,,,,`,
    ].join("\r\n");

    const first = await executeSubscriptionImport(user.id, csv, "duplicate");
    expect(first.created).toBe(1);
    const second = await executeSubscriptionImport(user.id, csv, "duplicate");
    // 已有行与 CSV 不完全一致？不 —— 首次创建的行完全一致，故跳过（幂等）
    expect(second).toMatchObject({ created: 0, skipped: 1, failed: [] });
    expect(await subCount(user.id)).toBe(1);

    // CSV 变了（价格不同）→ duplicate 仍会复制新建
    const changed = [
      HEADER,
      `${name},,,20,USD,monthly,,2026-01-01,,active,true,,,,`,
    ].join("\r\n");
    const third = await executeSubscriptionImport(user.id, changed, "duplicate");
    expect(third.created).toBe(1);
    expect(await subCount(user.id)).toBe(2);

    await db.user.delete({ where: { id: user.id } });
  });

  it("payment_method 必须命中已有支付方式，否则该行报错", async () => {
    const user = await makeUser();
    await db.paymentMethod.create({
      data: { userId: user.id, label: "招行信用卡", kind: "credit_card" },
    });
    const csv = [
      HEADER,
      `${unique("PmOk")},,,10,USD,monthly,,2026-01-01,,active,true,,招行信用卡,,`,
      `${unique("PmBad")},,,10,USD,monthly,,2026-01-01,,active,true,,不存在的卡,,`,
    ].join("\r\n");

    const preview = await previewSubscriptionImport(user.id, csv, "skip");
    expect(preview.summary.invalid).toBe(1);
    expect(preview.summary.create).toBe(1);

    const result = await executeSubscriptionImport(user.id, csv, "skip");
    expect(result.created).toBe(1);
    expect(result.failed).toHaveLength(1);
    const created = await db.subscription.findFirst({
      where: { userId: user.id },
      include: { paymentMethod: true },
    });
    expect(created?.paymentMethod?.label).toBe("招行信用卡");

    await db.user.delete({ where: { id: user.id } });
  });

  it("round-trip：导出 → 预检零错误 → skip 确认全部收敛", async () => {
    const user = await makeUser();
    const vendor = await db.vendor.create({
      data: { slug: unique("rt"), name: "Round Trip, Inc", category: "ai", userId: user.id },
    });
    const pm = await db.paymentMethod.create({
      data: { userId: user.id, label: "PayPal", kind: "paypal" },
    });
    await db.subscription.create({
      data: {
        userId: user.id,
        vendorId: vendor.id,
        paymentMethodId: pm.id,
        name: 'Claude "Max"',
        planName: "Max 5x",
        status: "active",
        price: 200,
        currency: "USD",
        billingCycle: "monthly",
        anchorDay: 9,
        startedAt: new Date("2026-01-09T00:00:00Z"),
        autoRenew: true,
        tags: ["ai", "工作"],
        notes: "含逗号, 与\n换行",
      },
    });
    await db.subscription.create({
      data: {
        userId: user.id,
        name: "Custom Cycle",
        status: "paused",
        price: 30,
        currency: "CNY",
        billingCycle: "custom",
        cycleDays: 45,
        startedAt: new Date("2026-02-01T00:00:00Z"),
        autoRenew: false,
      },
    });

    const exported = exportText(user.id);
    const preview = await previewSubscriptionImport(user.id, await exported, "skip");
    expect(preview.summary.invalid).toBe(0); // 导出文件零错误回导
    expect(preview.summary.skip).toBe(2);

    const before = await subCount(user.id);
    const result = await executeSubscriptionImport(user.id, await exported, "skip");
    expect(result).toMatchObject({ created: 0, updated: 0, skipped: 2, failed: [] });
    expect(await subCount(user.id)).toBe(before);

    // 空账号 round-trip：无 PayPal 支付方式 → 该行报错；补齐后新建成功；
    // vendor 按名称自动新建（category 来自导出列），重复确认幂等收敛
    const fresh = await makeUser();
    const text = await exported;
    const importIntoFresh = await executeSubscriptionImport(fresh.id, text, "skip");
    expect(importIntoFresh.created).toBe(1); // Custom Cycle
    expect(importIntoFresh.failed).toHaveLength(1); // Claude "Max"：payment_method 不存在
    const custom = await db.subscription.findFirst({
      where: { userId: fresh.id, name: "Custom Cycle" },
    });
    expect(custom?.billingCycle).toBe("custom");
    expect(custom?.cycleDays).toBe(45);
    expect(custom?.status).toBe("paused");
    expect(custom?.autoRenew).toBe(false);

    await db.paymentMethod.create({
      data: { userId: fresh.id, label: "paypal", kind: "paypal" }, // 大小写不敏感命中
    });
    const retry = await executeSubscriptionImport(fresh.id, text, "skip");
    expect(retry).toMatchObject({ created: 1, failed: [] });
    const claude = await db.subscription.findFirst({
      where: { userId: fresh.id, name: 'Claude "Max"' },
      include: { vendor: true, paymentMethod: true },
    });
    expect(claude?.vendor?.name).toBe("Round Trip, Inc");
    expect(claude?.vendor?.category).toBe("ai");
    expect(claude?.paymentMethod?.label).toBe("paypal");
    expect(claude?.notes).toBe("含逗号, 与\n换行");
    expect(claude?.tags).toEqual(["ai", "工作"]);

    const total = await subCount(fresh.id);
    const again = await executeSubscriptionImport(fresh.id, text, "skip");
    expect(again.created).toBe(0);
    expect(await subCount(fresh.id)).toBe(total);

    await db.user.delete({ where: { id: user.id } });
    await db.user.delete({ where: { id: fresh.id } });
  });
});
