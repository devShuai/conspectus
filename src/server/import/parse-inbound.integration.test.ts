import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { db } from "@/server/db";
import { loadCredentialKeyring } from "@/server/auth/crypto";

import { parseImportDraftPayload } from "./draft-payload";
import { recordInboundEmail } from "./inbound";
import { IMPORT_DRAFT_TTL_MS, parseInboundEmail } from "./parse-inbound";

/**
 * #60 接线集成测试：InboundEmail → 解析 → ImportDraft 全链路打真实测试库。
 * 断言只用本测试自建 user 维度，不断言全局计数。
 */
const DISABLED = !process.env.TEST_DATABASE_URL;

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

async function makeUser() {
  // users_login_method / users_local_email_required CHECK：本地账号必须带邮箱
  return db.user.create({
    data: {
      email: `m6-parse-${randomUUID()}@example.test`,
      passwordHash: "m6-parse-test-not-a-real-hash",
    },
  });
}

async function recordFixture(
  user: { id: string; inboundRetainRaw: boolean },
  raw: string | undefined,
  subject: string,
  fromAddr: string,
) {
  const messageId = `<parse-${randomUUID()}@mail.test>`;
  const result = await recordInboundEmail(
    user,
    {
      messageId,
      from: fromAddr,
      to: "u-abcdefghijklmnopqrstuvwxyz@in.example.test",
      subject,
      receivedAt: "2026-08-06T00:00:00.000Z",
      ...(raw !== undefined ? { raw: Buffer.from(raw, "utf8").toString("base64") } : {}),
    },
    loadCredentialKeyring(),
    new Date("2026-08-06T00:00:00.000Z"),
  );
  expect(result).toBe("created");
  return messageId;
}

describe.skipIf(DISABLED)("parseInboundEmail (#60)", () => {
  it("命中规则：建 pending 草稿 + parseStatus=parsed，payload 过版本化 schema", async () => {
    const user = await makeUser();
    const messageId = await recordFixture(
      { id: user.id, inboundRetainRaw: true },
      fixture("netflix-receipt.eml"),
      "Your Netflix receipt",
      "info@mailer.netflix.com",
    );

    const result = await parseInboundEmail(user.id, messageId, loadCredentialKeyring());
    expect(result).toMatchObject({
      status: "parsed",
      matchedRule: "netflix/receipt/v1",
      confidence: 0.95,
    });

    const drafts = await db.importDraft.findMany({ where: { userId: user.id } });
    expect(drafts).toHaveLength(1);
    const draft = drafts[0];
    expect(draft.source).toBe("email");
    expect(draft.status).toBe("pending"); // 绝不自动接受（§7.5 底线）
    expect(Number(draft.confidence)).toBe(0.95);
    expect(draft.suggestedSubscriptionId).toBeNull();
    // createdAt 取 DB now()，与 expiresAt 基准有几毫秒差 —— 容差断言
    const ttl = draft.expiresAt.getTime() - draft.createdAt.getTime();
    expect(Math.abs(ttl - IMPORT_DRAFT_TTL_MS)).toBeLessThan(60_000);

    const payload = parseImportDraftPayload(draft.payload);
    expect(payload.candidate).toMatchObject({
      vendorSlug: "netflix",
      name: "Netflix",
      amount: "15.49",
      currency: "USD",
      billedAt: "2026-08-01",
      billingCycle: "monthly",
    });
    expect(payload.evidence?.matchedRule).toBe("netflix/receipt/v1");

    const email = await db.inboundEmail.findUniqueOrThrow({
      where: { userId_messageId: { userId: user.id, messageId } },
    });
    expect(email.parseStatus).toBe("parsed");

    await db.user.delete({ where: { id: user.id } });
  });

  it("恰好一条订阅命中时写入 suggestedSubscriptionId", async () => {
    const user = await makeUser();
    const vendor = await db.vendor.create({
      data: { slug: "netflix", name: "Netflix", category: "streaming", userId: user.id },
    });
    const sub = await db.subscription.create({
      data: {
        userId: user.id,
        vendorId: vendor.id,
        name: "Netflix",
        status: "active",
        price: "15.49",
        currency: "USD",
        billingCycle: "monthly",
        startedAt: new Date("2026-01-01T00:00:00Z"),
      },
    });
    const messageId = await recordFixture(
      { id: user.id, inboundRetainRaw: true },
      fixture("netflix-receipt.eml"),
      "Your Netflix receipt",
      "info@mailer.netflix.com",
    );

    const result = await parseInboundEmail(user.id, messageId, loadCredentialKeyring());
    expect(result.status).toBe("parsed");
    const draft = await db.importDraft.findFirstOrThrow({ where: { userId: user.id } });
    expect(draft.suggestedSubscriptionId).toBe(sub.id);

    await db.user.delete({ where: { id: user.id } });
  });

  it("模板漂移：parseStatus=failed、零草稿（可诊断失败，不猜值）", async () => {
    const user = await makeUser();
    const messageId = await recordFixture(
      { id: user.id, inboundRetainRaw: true },
      fixture("netflix-receipt-drift.eml"),
      "Your Netflix receipt",
      "info@mailer.netflix.com",
    );

    const result = await parseInboundEmail(user.id, messageId, loadCredentialKeyring());
    expect(result).toMatchObject({
      status: "failed",
      reason: "template_drift",
      matchedRule: "netflix/receipt/v1",
    });
    expect(await db.importDraft.count({ where: { userId: user.id } })).toBe(0);
    const email = await db.inboundEmail.findUniqueOrThrow({
      where: { userId_messageId: { userId: user.id, messageId } },
    });
    expect(email.parseStatus).toBe("failed");

    await db.user.delete({ where: { id: user.id } });
  });

  it("用户关闭原文保留：仅主题可解析，凑不齐必填字段 → failed 且零草稿", async () => {
    const user = await makeUser();
    const messageId = await recordFixture(
      { id: user.id, inboundRetainRaw: false },
      undefined,
      "Your Netflix receipt",
      "info@mailer.netflix.com",
    );

    const result = await parseInboundEmail(user.id, messageId, loadCredentialKeyring());
    // 主题命中 netflix 规则，但无正文可抽取 → 模板证据不足，按可诊断失败处理
    expect(result.status).toBe("failed");
    expect(await db.importDraft.count({ where: { userId: user.id } })).toBe(0);

    await db.user.delete({ where: { id: user.id } });
  });

  it("幂等：已 parsed 的行重复调用 skipped，草稿不重复建", async () => {
    const user = await makeUser();
    const messageId = await recordFixture(
      { id: user.id, inboundRetainRaw: true },
      fixture("netflix-receipt.eml"),
      "Your Netflix receipt",
      "info@mailer.netflix.com",
    );

    const first = await parseInboundEmail(user.id, messageId, loadCredentialKeyring());
    const second = await parseInboundEmail(user.id, messageId, loadCredentialKeyring());
    expect(first.status).toBe("parsed");
    expect(second.status).toBe("skipped");
    expect(await db.importDraft.count({ where: { userId: user.id } })).toBe(1);

    await db.user.delete({ where: { id: user.id } });
  });

  it("未知 messageId / 不存在的行：skipped", async () => {
    const user = await makeUser();
    const result = await parseInboundEmail(
      user.id,
      `<missing-${randomUUID()}@mail.test>`,
      loadCredentialKeyring(),
    );
    expect(result.status).toBe("skipped");
    await db.user.delete({ where: { id: user.id } });
  });
});
