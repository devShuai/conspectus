import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { beforeAll, describe, expect, it } from "vitest";

import { db } from "@/server/db";
import { runPurge } from "@/server/auth/purge";
import { dashboardStats } from "@/server/billing/stats";

import { clearInboundRawNow, rotateInboundAlias } from "./alias";
import { DraftError, acceptDraft, listInboxDrafts, rejectDraft, updateDraftCandidate } from "./drafts";
import { parseImportDraftPayload } from "./draft-payload";
import { INBOUND_RAW_RETENTION_MS, signInboundRequest } from "./inbound";

/**
 * #62 M6 关闭 E2E（design §7.5 全链路 + §12.3 导入行）：一封 fixture 扣款邮件
 * 经真实路由（HMAC 签名 → 限流 → 幂等落库 → 同请求解析）产出草稿，用户编辑、
 * 接受后生成订阅/账单/投影；并覆盖重复投递、错签名、未知模板低置信度、
 * 过期/拒绝与原文生命周期（30 天到期清理、立即清除）。全部打真实测试库，
 * 断言只用本测试自建 user 维度。
 */
const DISABLED = !process.env.TEST_DATABASE_URL;

// 与 route.integration.test.ts 同值：vitest 同 fork 内 process.env 跨文件共享，
// 同值覆盖互不干扰
const SECRET = "test-inbound-webhook-secret-0123456789abcdef";
const DOMAIN = "in.example.test";

process.env.INBOUND_WEBHOOK_SECRET = SECRET;

const { POST } = await import("@/app/api/inbound/email/route");

const EN_MONTHS_FULL = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** 把 fixture 里的固定扣费日替换为今天（UTC）：实付统计按当月断言才不随日历失效。 */
function netflixRawAtToday(now: Date = new Date()): { raw: string; billedAt: string } {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  const pad = (n: number) => String(n).padStart(2, "0");
  const token = `${EN_MONTHS_FULL[m]} ${d}, ${y}`;
  const raw = readFileSync(
    new URL("./fixtures/netflix-receipt.eml", import.meta.url),
    "utf8",
  ).replace("August 1, 2026", token);
  return { raw, billedAt: `${y}-${pad(m + 1)}-${pad(d)}` };
}

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

async function makeUserWithAlias(baseCurrency = "USD") {
  // users_login_method / users_local_email_required CHECK：本地账号必须带邮箱
  const user = await db.user.create({
    data: {
      email: `m6-e2e-${randomUUID()}@example.test`,
      passwordHash: "m6-e2e-test-not-a-real-hash",
      baseCurrency,
    },
  });
  const alias = await rotateInboundAlias(user.id);
  return { user, to: `${alias}@${DOMAIN}` };
}

async function postSigned(bodyText: string, secret: string = SECRET): Promise<Response> {
  const timestamp = String(Date.now());
  const signature = signInboundRequest(secret, timestamp, bodyText);
  return POST(
    new Request("http://localhost/api/inbound/email", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-inbound-timestamp": timestamp,
        "x-inbound-signature": signature,
      },
      body: bodyText,
    }),
  );
}

beforeAll(async () => {
  // 共享测试库：清 inbound 域限流计数，避免跨运行残留影响
  await db.rateLimitCounter.deleteMany({ where: { scope: { startsWith: "inbound:email" } } });
});

describe.skipIf(DISABLED)("M6 E2E (#62)", () => {
  it("全链路：转发 → 解析 → 草稿 → 编辑 → 接受 → 订阅/账单/投影落库；未确认不进实付统计；重复投递幂等", async () => {
    const { user, to } = await makeUserWithAlias("USD");
    const { raw, billedAt } = netflixRawAtToday();
    const messageId = `<m6e2e-${randomUUID()}@mail.test>`;
    const body = JSON.stringify({
      messageId,
      from: "Netflix <info@mailer.netflix.com>",
      to,
      subject: "Your Netflix receipt",
      receivedAt: new Date().toISOString(),
      raw: Buffer.from(raw, "utf8").toString("base64"),
    });

    const response = await postSigned(body);
    expect(response.status).toBe(202);

    // 落库 + 同请求解析完成（#60 接线）：parsed，原文加密留存，保留窗 ≈ 30 天
    const email = await db.inboundEmail.findUniqueOrThrow({
      where: { userId_messageId: { userId: user.id, messageId } },
    });
    expect(email.parseStatus).toBe("parsed");
    expect(email.rawCipher).not.toBeNull();
    expect(email.fromAddr).toBe("Netflix <info@mailer.netflix.com>");
    const retention = email.rawRetainedUntil!.getTime() - email.createdAt.getTime();
    expect(Math.abs(retention - INBOUND_RAW_RETENTION_MS)).toBeLessThan(60_000);

    // 草稿：pending、置信度、证据回链来源邮件
    const drafts = await db.importDraft.findMany({ where: { userId: user.id } });
    expect(drafts).toHaveLength(1);
    const draft = drafts[0];
    expect(draft.status).toBe("pending");
    expect(Number(draft.confidence)).toBe(0.95);
    const parsed = parseImportDraftPayload(draft.payload);
    expect(parsed.candidate).toMatchObject({
      vendorSlug: "netflix",
      name: "Netflix",
      planName: "Standard",
      amount: "15.49",
      currency: "USD",
      billedAt,
      billingCycle: "monthly",
      reference: "NF-2026-0801-ABC123",
    });
    expect(parsed.evidence?.sourceMessageId).toBe(messageId);
    expect(parsed.evidence?.matchedRule).toBe("netflix/receipt/v1");

    // 未确认：不进 BillingRecord、不进实付统计（§12.3 导入行）；Inbox 可见
    expect(await db.billingRecord.count({ where: { userId: user.id } })).toBe(0);
    const before = await dashboardStats(user.id);
    expect(before.monthCharges).toBe(0);
    expect(before.monthNetSpend).toBe(0);
    const inboxBefore = await listInboxDrafts(user.id);
    expect(inboxBefore).toHaveLength(1);
    expect(inboxBefore[0].sourceReceivedAt?.getTime()).toBe(email.receivedAt.getTime());

    // 编辑：校正金额与套餐（用户确认前的字段修正）
    await updateDraftCandidate(user.id, draft.id, {
      name: "Netflix",
      planName: "Premium",
      amount: "16.49",
      currency: "USD",
      billedAt,
      billingCycle: "monthly",
      reference: "NF-2026-0801-ABC123",
    });

    // 接受：建订阅 + paid 账单 + 投影，全在草稿确认之后
    const accepted = await acceptDraft(user.id, draft.id);
    expect(accepted.createdSubscription).toBe(true);
    expect(accepted.projected).toBe(true);

    const sub = await db.subscription.findUniqueOrThrow({
      where: { id: accepted.subscriptionId },
    });
    expect(sub.name).toBe("Netflix");
    expect(sub.planName).toBe("Premium");
    expect(Number(sub.price)).toBe(16.49);
    expect(sub.currency).toBe("USD");
    expect(sub.billingCycle).toBe("monthly");
    expect(sub.status).toBe("active");

    const record = await db.billingRecord.findUniqueOrThrow({
      where: { id: accepted.billingRecordId },
    });
    expect(Number(record.amount)).toBe(16.49);
    expect(record.status).toBe("paid");
    expect(record.source).toBe("email");
    expect(record.externalRef).toBe(`draft:${draft.id}`);
    expect(record.billedAt.getTime()).toBe(new Date(`${billedAt}T00:00:00.000Z`).getTime());

    const conversion = await db.billingConversion.findUniqueOrThrow({
      where: {
        billingRecordId_baseCurrency: {
          billingRecordId: record.id,
          baseCurrency: "USD",
        },
      },
    });
    expect(Number(conversion.signedAmountInBase)).toBe(16.49);
    expect(Number(conversion.fxRate)).toBe(1);
    expect(conversion.rateSource).toBe("provider");

    const after = await dashboardStats(user.id);
    expect(after.monthCharges).toBe(16.49);
    expect(after.monthNetSpend).toBe(16.49);
    expect(await listInboxDrafts(user.id)).toHaveLength(0);

    // 重复投递（平台重试）：202 但零新写入 —— 邮件/草稿/账单都不翻倍
    const duplicate = await postSigned(body);
    expect(duplicate.status).toBe(202);
    expect(await db.inboundEmail.count({ where: { userId: user.id } })).toBe(1);
    expect(await db.importDraft.count({ where: { userId: user.id } })).toBe(1);
    expect(await db.billingRecord.count({ where: { userId: user.id } })).toBe(1);

    await db.user.delete({ where: { id: user.id } });
  });

  it("错签名：401 invalid_signature 且零写入", async () => {
    const { user, to } = await makeUserWithAlias();
    const messageId = `<m6e2e-badsig-${randomUUID()}@mail.test>`;
    const body = JSON.stringify({
      messageId,
      from: "info@mailer.netflix.com",
      to,
      subject: "Your Netflix receipt",
      receivedAt: new Date().toISOString(),
      raw: Buffer.from(fixture("netflix-receipt.eml"), "utf8").toString("base64"),
    });

    const response = await postSigned(body, "wrong-secret");
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: "invalid_signature" });
    expect(await db.inboundEmail.count({ where: { userId: user.id } })).toBe(0);
    expect(await db.importDraft.count({ where: { userId: user.id } })).toBe(0);

    await db.user.delete({ where: { id: user.id } });
  });

  it("未知模板：低置信度启发式草稿（必须人工确认）；拒绝与过期草稿不可接受", async () => {
    const { user, to } = await makeUserWithAlias();
    const raw = fixture("heuristic-unknown-vendor.eml");
    const post = async () => {
      const messageId = `<m6e2e-acme-${randomUUID()}@mail.test>`;
      const response = await postSigned(
        JSON.stringify({
          messageId,
          from: "Acme Billing <billing@acme-saas.io>",
          to,
          subject: "Your Acme receipt",
          receivedAt: new Date().toISOString(),
          raw: Buffer.from(raw, "utf8").toString("base64"),
        }),
      );
      expect(response.status).toBe(202);
      return messageId;
    };

    // 未知模板：无规则命中 → 启发式草稿，置信度 0.8 < 0.9 预选线（§7.5 必须人工确认）
    await post();
    const heuristic = await db.importDraft.findFirstOrThrow({ where: { userId: user.id } });
    expect(heuristic.status).toBe("pending");
    expect(Number(heuristic.confidence)).toBe(0.8);
    expect(Number(heuristic.confidence)).toBeLessThan(0.9);
    const heuristicPayload = parseImportDraftPayload(heuristic.payload);
    expect(heuristicPayload.evidence?.matchedRule).toBeUndefined();
    expect(heuristicPayload.candidate).toMatchObject({
      name: "Acme-saas",
      amount: "42.50",
      currency: "USD",
      billedAt: "2026-08-05",
    });

    // 拒绝：终态，不再可接受，零账单
    await rejectDraft(user.id, heuristic.id);
    await expect(acceptDraft(user.id, heuristic.id)).rejects.toMatchObject({
      code: "conflict",
    });
    expect(await db.billingRecord.count({ where: { userId: user.id } })).toBe(0);

    // 过期：purge 把超窗 pending 置 expired，接受/拒绝都拒绝
    await post();
    const expiring = await db.importDraft.findFirstOrThrow({
      where: { userId: user.id, status: "pending" },
    });
    await db.importDraft.update({
      where: { id: expiring.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    await runPurge();
    expect(
      (await db.importDraft.findUniqueOrThrow({ where: { id: expiring.id } })).status,
    ).toBe("expired");
    await expect(acceptDraft(user.id, expiring.id)).rejects.toSatisfy(
      (e) => e instanceof DraftError && e.code === "expired",
    );
    await expect(rejectDraft(user.id, expiring.id)).rejects.toMatchObject({
      code: "expired",
    });
    expect(await db.billingRecord.count({ where: { userId: user.id } })).toBe(0);

    await db.user.delete({ where: { id: user.id } });
  });

  it("原文生命周期：30 天到期 purge 置空（行保留）；立即清除；元数据不动", async () => {
    const { user, to } = await makeUserWithAlias();
    const messageId = `<m6e2e-raw-${randomUUID()}@mail.test>`;
    const response = await postSigned(
      JSON.stringify({
        messageId,
        from: "info@mailer.netflix.com",
        to,
        subject: "Your Netflix receipt",
        receivedAt: new Date().toISOString(),
        raw: Buffer.from(fixture("netflix-receipt.eml"), "utf8").toString("base64"),
      }),
    );
    expect(response.status).toBe(202);
    const email = await db.inboundEmail.findUniqueOrThrow({
      where: { userId_messageId: { userId: user.id, messageId } },
    });
    expect(email.rawCipher).not.toBeNull();

    // 到期（把保留期拨到过去等价于 30 天窗口到达）：purge 置空 rawCipher，行与元数据保留
    await db.inboundEmail.update({
      where: { id: email.id },
      data: { rawRetainedUntil: new Date(Date.now() - 60_000) },
    });
    await runPurge();
    const purged = await db.inboundEmail.findUniqueOrThrow({ where: { id: email.id } });
    expect(purged.rawCipher).toBeNull();
    expect(purged.fromAddr).toBe("info@mailer.netflix.com");
    expect(purged.subject).toBe("Your Netflix receipt");
    expect(purged.parseStatus).toBe("parsed"); // 解析产物（草稿）不受原文清理影响
    expect(await db.importDraft.count({ where: { userId: user.id } })).toBe(1);

    // 立即清除：再收一封带原文的邮件，用户点「立即清除」后即时置空
    const secondMessageId = `<m6e2e-raw2-${randomUUID()}@mail.test>`;
    await postSigned(
      JSON.stringify({
        messageId: secondMessageId,
        from: "Acme Billing <billing@acme-saas.io>",
        to,
        subject: "Your Acme receipt",
        receivedAt: new Date().toISOString(),
        raw: Buffer.from(fixture("heuristic-unknown-vendor.eml"), "utf8").toString("base64"),
      }),
    );
    const second = await db.inboundEmail.findUniqueOrThrow({
      where: { userId_messageId: { userId: user.id, messageId: secondMessageId } },
    });
    expect(second.rawCipher).not.toBeNull();
    await clearInboundRawNow(user.id);
    expect(
      (await db.inboundEmail.findUniqueOrThrow({ where: { id: second.id } })).rawCipher,
    ).toBeNull();
    // 行保留：两封邮件的元数据都还在
    expect(await db.inboundEmail.count({ where: { userId: user.id } })).toBe(2);

    await db.user.delete({ where: { id: user.id } });
  });
});
