import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { db } from "@/server/db";
import { recordPaidCharge } from "@/server/billing/billing";
import { dashboardStats } from "@/server/billing/stats";

import type { ImportDraftPayloadV1 } from "./draft-payload";
import {
  DraftError,
  acceptDraft,
  listInboxDrafts,
  rejectDraft,
  updateDraftCandidate,
} from "./drafts";

/**
 * #61 Inbox 草稿服务层：列表租户隔离、编辑校正、accept/reject 的 CAS 与并发
 * 幂等、以及「确认即入账」与手工入账的投影一致性。全部打真实测试库，断言
 * 只用本测试自建 user 维度。
 */
const DISABLED = !process.env.TEST_DATABASE_URL;

const DAY_MS = 86_400_000;

async function makeUser(baseCurrency = "CNY") {
  // users_login_method / users_local_email_required CHECK：本地账号必须带邮箱
  return db.user.create({
    data: {
      email: `m6-drafts-${randomUUID()}@example.test`,
      passwordHash: "m6-drafts-test-not-a-real-hash",
      baseCurrency,
    },
  });
}

function makePayload(
  overrides: Partial<ImportDraftPayloadV1["candidate"]> = {},
  evidence?: ImportDraftPayloadV1["evidence"],
): ImportDraftPayloadV1 {
  return {
    version: 1,
    candidate: {
      name: "Netflix",
      amount: "15.49",
      currency: "USD",
      billedAt: "2020-01-15",
      billingCycle: "monthly",
      ...overrides,
    },
    ...(evidence ? { evidence } : {}),
  };
}

async function makeDraft(
  userId: string,
  overrides: {
    payload?: ImportDraftPayloadV1;
    status?: "pending" | "accepted" | "rejected" | "expired";
    confidence?: number;
    suggestedSubscriptionId?: string;
    expiresAt?: Date;
  } = {},
) {
  return db.importDraft.create({
    data: {
      userId,
      source: "email",
      payload: overrides.payload ?? makePayload(),
      confidence: overrides.confidence ?? 0.95,
      status: overrides.status ?? "pending",
      suggestedSubscriptionId: overrides.suggestedSubscriptionId ?? null,
      expiresAt: overrides.expiresAt ?? new Date(Date.now() + 7 * DAY_MS),
    },
  });
}

async function cleanupUser(userId: string) {
  await db.user.delete({ where: { id: userId } });
}

describe.skipIf(DISABLED)("inbox drafts service (#61)", () => {
  it("列表只含本人 pending 草稿，并解析出来源时间与建议订阅名", async () => {
    const user = await makeUser();
    const other = await makeUser();
    const messageId = `<src-${randomUUID()}@mail.test>`;
    const receivedAt = new Date("2020-01-14T10:00:00.000Z");
    await db.inboundEmail.create({
      data: {
        userId: user.id,
        messageId,
        fromAddr: "info@mailer.netflix.com",
        subject: "Your Netflix receipt",
        receivedAt,
      },
    });
    const sub = await db.subscription.create({
      data: {
        userId: user.id,
        name: "Netflix",
        status: "active",
        price: "15.49",
        currency: "USD",
        billingCycle: "monthly",
        startedAt: new Date("2020-01-01T00:00:00Z"),
      },
    });
    const draft = await makeDraft(user.id, {
      payload: makePayload({}, { sourceMessageId: messageId, fromAddr: "info@mailer.netflix.com" }),
      suggestedSubscriptionId: sub.id,
    });
    await makeDraft(user.id, { status: "rejected" }); // 终态不进 Inbox
    await makeDraft(other.id); // 跨租户不进 Inbox

    const items = await listInboxDrafts(user.id);
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe(draft.id);
    expect(items[0].payload.candidate.name).toBe("Netflix");
    expect(items[0].confidence).toBe(0.95);
    expect(items[0].sourceReceivedAt?.getTime()).toBe(receivedAt.getTime());
    expect(items[0].suggestedSubscriptionId).toBe(sub.id);
    expect(items[0].suggestedSubscriptionName).toBe("Netflix");

    await cleanupUser(user.id);
    await cleanupUser(other.id);
  });

  it("编辑：校正字段并重算订阅建议；非法字段被拒绝", async () => {
    const user = await makeUser();
    const draft = await makeDraft(user.id); // amount 15.49 USD，无匹配订阅

    // 先建一个与「编辑后」金额匹配的订阅：保存后建议应指向它
    const sub = await db.subscription.create({
      data: {
        userId: user.id,
        name: "Netflix",
        status: "active",
        price: "16.49",
        currency: "USD",
        billingCycle: "monthly",
        startedAt: new Date("2020-01-01T00:00:00Z"),
      },
    });

    const result = await updateDraftCandidate(user.id, draft.id, {
      name: "Netflix",
      amount: "16.49",
      currency: "USD",
      billedAt: "2020-01-15",
      billingCycle: "monthly",
      planName: "Premium",
    });
    expect(result.suggestedSubscriptionId).toBe(sub.id);

    const saved = await db.importDraft.findUniqueOrThrow({ where: { id: draft.id } });
    expect(saved.suggestedSubscriptionId).toBe(sub.id);
    const payload = saved.payload as ImportDraftPayloadV1;
    expect(payload.candidate.amount).toBe("16.49");
    expect(payload.candidate.planName).toBe("Premium");

    await expect(
      updateDraftCandidate(user.id, draft.id, {
        name: "Netflix",
        amount: "16.499", // 三位小数，payload schema 拒绝
        currency: "USD",
        billedAt: "2020-01-15",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });

    await cleanupUser(user.id);
  });

  it("编辑的状态门禁：已接受 conflict、过期 expired、跨租户 not_found", async () => {
    const user = await makeUser();
    const other = await makeUser();
    const accepted = await makeDraft(user.id, { status: "accepted" });
    const overdue = await makeDraft(user.id, {
      expiresAt: new Date(Date.now() - 60_000),
    });
    const foreign = await makeDraft(other.id);
    const patch = {
      name: "X",
      amount: "1.00",
      currency: "USD",
      billedAt: "2020-01-15",
    };

    await expect(updateDraftCandidate(user.id, accepted.id, patch)).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(updateDraftCandidate(user.id, overdue.id, patch)).rejects.toMatchObject({
      code: "expired",
    });
    await expect(updateDraftCandidate(user.id, foreign.id, patch)).rejects.toMatchObject({
      code: "not_found",
    });

    await cleanupUser(user.id);
    await cleanupUser(other.id);
  });

  it("接受（无建议）：新建订阅（解析 vendor）+ paid 账单 + 投影，与手工入账同路径", async () => {
    const user = await makeUser("CNY");
    const vendor = await db.vendor.create({
      data: { slug: "netflix", name: "Netflix", category: "streaming", userId: user.id },
    });
    const billedAt = new Date("2020-01-15T00:00:00.000Z");
    // 预置汇率行：ensureFxRate 见到 ≤ billedAt 的行即跳过网络抓取
    await db.exchangeRate.create({
      data: { date: billedAt, base: "USD", quote: "CNY", rate: 7.1 },
    });
    const draft = await makeDraft(user.id, {
      payload: makePayload({ vendorSlug: "netflix", planName: "Standard" }),
    });

    const result = await acceptDraft(user.id, draft.id);
    expect(result.createdSubscription).toBe(true);
    expect(result.projected).toBe(true);

    const sub = await db.subscription.findUniqueOrThrow({
      where: { id: result.subscriptionId },
    });
    expect(sub.userId).toBe(user.id);
    expect(sub.vendorId).toBe(vendor.id);
    expect(sub.name).toBe("Netflix");
    expect(sub.planName).toBe("Standard");
    expect(Number(sub.price)).toBe(15.49);
    expect(sub.currency).toBe("USD");
    expect(sub.billingCycle).toBe("monthly");
    expect(sub.status).toBe("active");
    expect(sub.startedAt.getTime()).toBe(billedAt.getTime());

    const record = await db.billingRecord.findUniqueOrThrow({
      where: { id: result.billingRecordId },
    });
    expect(record.subscriptionId).toBe(sub.id);
    expect(Number(record.amount)).toBe(15.49);
    expect(record.currency).toBe("USD");
    expect(record.status).toBe("paid");
    expect(record.source).toBe("email");
    expect(record.externalRef).toBe(`draft:${draft.id}`);

    // 与手工入账完全一致：同金额/币种/日期的手工记录应产生相同投影
    const manualSub = await db.subscription.create({
      data: {
        userId: user.id,
        name: "Manual",
        status: "active",
        price: "15.49",
        currency: "USD",
        billingCycle: "monthly",
        startedAt: billedAt,
      },
    });
    const manual = await recordPaidCharge({
      userId: user.id,
      subscriptionId: manualSub.id,
      amount: 15.49,
      currency: "USD",
      billedAt,
      source: "manual",
    });
    const [draftConv, manualConv] = await Promise.all([
      db.billingConversion.findUniqueOrThrow({
        where: {
          billingRecordId_baseCurrency: {
            billingRecordId: result.billingRecordId,
            baseCurrency: "CNY",
          },
        },
      }),
      db.billingConversion.findUniqueOrThrow({
        where: {
          billingRecordId_baseCurrency: {
            billingRecordId: manual.billingRecordId,
            baseCurrency: "CNY",
          },
        },
      }),
    ]);
    expect(Number(draftConv.signedAmountInBase)).toBe(Number(manualConv.signedAmountInBase));
    expect(Number(draftConv.fxRate)).toBe(Number(manualConv.fxRate));
    expect(draftConv.fxDate.getTime()).toBe(manualConv.fxDate.getTime());
    expect(draftConv.rateSource).toBe(manualConv.rateSource);
    expect(draftConv.rateSource).toBe("provider");

    expect(
      (await db.importDraft.findUniqueOrThrow({ where: { id: draft.id } })).status,
    ).toBe("accepted");

    await db.exchangeRate.delete({
      where: { date_base_quote: { date: billedAt, base: "USD", quote: "CNY" } },
    });
    await cleanupUser(user.id);
  });

  it("接受（有建议）：不新建订阅，账单挂到建议订阅", async () => {
    const user = await makeUser("CNY");
    const sub = await db.subscription.create({
      data: {
        userId: user.id,
        name: "iCloud+",
        status: "active",
        price: "6.00",
        currency: "CNY",
        billingCycle: "monthly",
        startedAt: new Date("2020-01-01T00:00:00Z"),
      },
    });
    const draft = await makeDraft(user.id, {
      payload: makePayload({
        name: "iCloud+",
        amount: "6.00",
        currency: "CNY",
        billingCycle: "monthly",
      }),
      suggestedSubscriptionId: sub.id,
    });

    const result = await acceptDraft(user.id, draft.id);
    expect(result.createdSubscription).toBe(false);
    expect(result.subscriptionId).toBe(sub.id);
    expect(await db.subscription.count({ where: { userId: user.id } })).toBe(1);
    const record = await db.billingRecord.findUniqueOrThrow({
      where: { id: result.billingRecordId },
    });
    expect(record.subscriptionId).toBe(sub.id);

    await cleanupUser(user.id);
  });

  it("并发双击：只创建一笔 BillingRecord（CAS 只有一个赢家）", async () => {
    const user = await makeUser("CNY");
    const draft = await makeDraft(user.id, {
      payload: makePayload({ amount: "6.00", currency: "CNY" }),
    });

    const results = await Promise.allSettled([
      acceptDraft(user.id, draft.id),
      acceptDraft(user.id, draft.id),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(DraftError);
    expect(
      ((rejected[0] as PromiseRejectedResult).reason as DraftError).code,
    ).toBe("conflict");

    expect(await db.billingRecord.count({ where: { userId: user.id } })).toBe(1);
    expect(await db.subscription.count({ where: { userId: user.id } })).toBe(1);
    expect(
      (await db.importDraft.findUniqueOrThrow({ where: { id: draft.id } })).status,
    ).toBe("accepted");

    await cleanupUser(user.id);
  });

  it("重复 accept、已拒绝、过期、跨租户草稿全部被拒绝", async () => {
    const user = await makeUser("CNY");
    const other = await makeUser("CNY");
    const payload = makePayload({ amount: "6.00", currency: "CNY" });

    const accepted = await makeDraft(user.id, { payload });
    await acceptDraft(user.id, accepted.id);
    await expect(acceptDraft(user.id, accepted.id)).rejects.toMatchObject({
      code: "conflict",
    });
    expect(await db.billingRecord.count({ where: { userId: user.id } })).toBe(1);

    const rejectedDraft = await makeDraft(user.id, { payload, status: "rejected" });
    await expect(acceptDraft(user.id, rejectedDraft.id)).rejects.toMatchObject({
      code: "conflict",
    });

    const overdue = await makeDraft(user.id, {
      payload,
      expiresAt: new Date(Date.now() - 60_000),
    });
    await expect(acceptDraft(user.id, overdue.id)).rejects.toMatchObject({
      code: "expired",
    });

    const foreign = await makeDraft(other.id, { payload });
    await expect(acceptDraft(user.id, foreign.id)).rejects.toMatchObject({
      code: "not_found",
    });

    expect(await db.billingRecord.count({ where: { userId: user.id } })).toBe(1);
    expect(await db.billingRecord.count({ where: { userId: other.id } })).toBe(0);

    await cleanupUser(user.id);
    await cleanupUser(other.id);
  });

  it("未确认草稿不出现在 BillingRecord 与实付统计（§12.3 导入行）", async () => {
    const user = await makeUser("CNY");
    await makeDraft(user.id, {
      payload: makePayload({ amount: "6.00", currency: "CNY" }),
    });

    expect(await db.billingRecord.count({ where: { userId: user.id } })).toBe(0);
    const stats = await dashboardStats(user.id);
    expect(stats.monthCharges).toBe(0);
    expect(stats.monthNetSpend).toBe(0);
    expect(stats.missingProjections).toBe(0);

    await cleanupUser(user.id);
  });

  it("拒绝：CAS 生效且幂等拒绝重复操作；拒绝后不再出现在 Inbox", async () => {
    const user = await makeUser();
    const other = await makeUser();
    const draft = await makeDraft(user.id);
    const foreign = await makeDraft(other.id);

    await rejectDraft(user.id, draft.id);
    expect(
      (await db.importDraft.findUniqueOrThrow({ where: { id: draft.id } })).status,
    ).toBe("rejected");
    expect(await listInboxDrafts(user.id)).toHaveLength(0);

    await expect(rejectDraft(user.id, draft.id)).rejects.toMatchObject({ code: "conflict" });
    await expect(rejectDraft(user.id, foreign.id)).rejects.toMatchObject({
      code: "not_found",
    });

    const overdue = await makeDraft(user.id, {
      expiresAt: new Date(Date.now() - 60_000),
    });
    await expect(rejectDraft(user.id, overdue.id)).rejects.toMatchObject({ code: "expired" });

    expect(await db.billingRecord.count({ where: { userId: user.id } })).toBe(0);

    await cleanupUser(user.id);
    await cleanupUser(other.id);
  });
});
