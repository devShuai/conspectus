import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import { db } from "@/server/db";
import { decryptCredential, loadCredentialKeyring } from "@/server/auth/crypto";
import {
  INBOUND_RATE_LIMITS,
  consumeRateLimits,
  withRateLimitKey,
} from "@/server/auth/rate-limit";
import {
  revokeInboundAlias,
  rotateInboundAlias,
  setInboundRawRetention,
} from "@/server/import/alias";
import { signInboundRequest } from "@/server/import/inbound";

/**
 * #58 端到端：POST /api/inbound/email 的鉴权、限流、幂等与零泄露纪律，
 * 以及别名轮换/撤销对入站映射的即时生效。全部打真实测试库。
 */

const DISABLED = !process.env.TEST_DATABASE_URL;
const SECRET = "test-inbound-webhook-secret-0123456789abcdef";
const DOMAIN = "in.example.test";

process.env.INBOUND_WEBHOOK_SECRET = SECRET;

const { POST } = await import("./route");

function makeBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    messageId: `<m-${randomUUID()}@mail.test>`,
    from: "billing@vendor.test",
    to: `u-placeholder@placeholder.test`,
    subject: "Your receipt",
    receivedAt: new Date().toISOString(),
    raw: Buffer.from("From: billing@vendor.test\r\n\r\namount due", "utf8").toString("base64"),
    ...overrides,
  });
}

function signedRequest(
  bodyText: string,
  opts: {
    secret?: string;
    timestamp?: string;
    signBody?: string;
    contentType?: string;
    headers?: Record<string, string>;
    unsigned?: boolean;
  } = {},
): Request {
  const timestamp = opts.timestamp ?? String(Date.now());
  const signature = signInboundRequest(opts.secret ?? SECRET, timestamp, opts.signBody ?? bodyText);
  const headers: Record<string, string> = {
    "content-type": opts.contentType ?? "application/json",
    ...(opts.unsigned
      ? {}
      : { "x-inbound-timestamp": timestamp, "x-inbound-signature": signature }),
    ...opts.headers,
  };
  return new Request("http://localhost/api/inbound/email", {
    method: "POST",
    headers,
    body: bodyText,
  });
}

async function makeUser() {
  // users_login_method / users_local_email_required CHECK：本地账号必须带邮箱
  return db.user.create({
    data: {
      email: `inbound-${randomUUID()}@example.test`,
      passwordHash: "inbound-test-not-a-real-hash",
    },
  });
}

async function rowCount(messageId: string): Promise<number> {
  return db.inboundEmail.count({ where: { messageId } });
}

beforeAll(async () => {
  // 共享测试库：计数器跨运行残留会让 IP/别名维度限流用例不确定，先清 inbound 域
  await db.rateLimitCounter.deleteMany({ where: { scope: { startsWith: "inbound:email" } } });
});

describe.skipIf(DISABLED)("POST /api/inbound/email (#58)", () => {
  it("未配置共享密钥时返回 404（功能未启用）", async () => {
    const saved = process.env.INBOUND_WEBHOOK_SECRET;
    delete process.env.INBOUND_WEBHOOK_SECRET;
    try {
      const res = await POST(signedRequest(makeBody()));
      expect(res.status).toBe(404);
    } finally {
      process.env.INBOUND_WEBHOOK_SECRET = saved;
    }
  });

  it("缺签名头 / 过期时间戳 / 错签名全部 401 且零写入", async () => {
    const body = makeBody();
    const messageId = JSON.parse(body).messageId as string;

    const missing = await POST(signedRequest(body, { unsigned: true }));
    expect(missing.status).toBe(401);

    const stale = await POST(
      signedRequest(body, { timestamp: String(Date.now() - 10 * 60_000) }),
    );
    expect(stale.status).toBe(401);
    expect((await stale.json()).error).toBe("stale_timestamp");

    const wrongSecret = await POST(signedRequest(body, { secret: "wrong-secret" }));
    expect(wrongSecret.status).toBe(401);

    const tampered = await POST(signedRequest(body, { signBody: body + "x" }));
    expect(tampered.status).toBe(401);

    expect(await rowCount(messageId)).toBe(0);
  });

  it("非 JSON 类型 415、超尺寸 413、坏 JSON/越权字段 400，均零写入", async () => {
    const asForm = await POST(
      signedRequest("a=b", { contentType: "application/x-www-form-urlencoded" }),
    );
    expect(asForm.status).toBe(415);

    const huge = JSON.stringify({
      messageId: `<huge-${randomUUID()}@m.test>`,
      from: "a@b.c",
      to: "u-x@y.z",
      subject: "s",
      receivedAt: new Date().toISOString(),
      raw: "a".repeat(1100 * 1024),
    });
    const tooBig = await POST(
      new Request("http://localhost/api/inbound/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: huge,
      }),
    );
    expect(tooBig.status).toBe(413);

    const badJson = await POST(signedRequest("not json"));
    expect(badJson.status).toBe(400);

    // strict schema：html 等未声明字段没有入口（危险内容结构性排除）
    const smuggled = makeBody({ html: "<script>alert(1)</script>" });
    const res = await POST(signedRequest(smuggled));
    expect(res.status).toBe(400);
    expect(await rowCount(JSON.parse(smuggled).messageId as string)).toBe(0);

    const badRaw = makeBody({ raw: "!!!not-base64!!!" });
    expect((await POST(signedRequest(badRaw))).status).toBe(400);
  });

  it("未知别名与形态非法地址：统一 202、零写入、不泄露映射", async () => {
    const unknownAlias = `u-${"b".repeat(26)}`;
    const body = makeBody({ to: `${unknownAlias}@${DOMAIN}` });
    const res = await POST(signedRequest(body));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await rowCount(JSON.parse(body).messageId as string)).toBe(0);

    const malformed = makeBody({ to: "someone@gmail.test" });
    expect((await POST(signedRequest(malformed))).status).toBe(202);
    expect(await rowCount(JSON.parse(malformed).messageId as string)).toBe(0);
  });

  it("合法转发创建一条幂等 InboundEmail，原文 envelope 加密可回读", async () => {
    const user = await makeUser();
    const alias = await rotateInboundAlias(user.id);
    const rawText = "From: billing@vendor.test\r\nSubject: receipt\r\n\r\ncharged 68 CNY";
    const body = makeBody({
      to: `${alias}@${DOMAIN}`,
      raw: Buffer.from(rawText, "utf8").toString("base64"),
    });
    const messageId = JSON.parse(body).messageId as string;

    const res = await POST(signedRequest(body));
    expect(res.status).toBe(202);

    const row = await db.inboundEmail.findUniqueOrThrow({
      where: { userId_messageId: { userId: user.id, messageId } },
    });
    // #60：落库后同请求内已触发解析；该 fixture 无规则命中且正文无日期，
    // 按 fail-closed 置 failed（不产草稿、不猜值）
    expect(row.parseStatus).toBe("failed");
    expect(row.fromAddr).toBe("billing@vendor.test");
    expect(row.rawRetainedUntil).not.toBeNull();
    const plaintext = decryptCredential(row.rawCipher!, loadCredentialKeyring());
    expect(plaintext.toString("utf8")).toBe(rawText);

    // 窗口内原样重放：幂等，不新增行
    expect((await POST(signedRequest(body))).status).toBe(202);
    // 并发同 messageId：只入站一次
    await Promise.all([POST(signedRequest(body)), POST(signedRequest(body))]);
    expect(await rowCount(messageId)).toBe(1);

    await db.user.delete({ where: { id: user.id } });
  });

  it("用户关闭原文保留时 rawCipher/rawRetainedUntil 恒空", async () => {
    const user = await makeUser();
    const alias = await rotateInboundAlias(user.id);
    await setInboundRawRetention(user.id, false);

    const body = makeBody({ to: `${alias}@${DOMAIN}` });
    const messageId = JSON.parse(body).messageId as string;
    expect((await POST(signedRequest(body))).status).toBe(202);

    const row = await db.inboundEmail.findUniqueOrThrow({
      where: { userId_messageId: { userId: user.id, messageId } },
    });
    expect(row.rawCipher).toBeNull();
    expect(row.rawRetainedUntil).toBeNull();

    await db.user.delete({ where: { id: user.id } });
  });

  it("轮换后旧别名立即失效、新别名生效；停用后入站零写入", async () => {
    const user = await makeUser();
    const oldAlias = await rotateInboundAlias(user.id);
    const newAlias = await rotateInboundAlias(user.id);
    expect(newAlias).not.toBe(oldAlias);

    const toOld = makeBody({ to: `${oldAlias}@${DOMAIN}` });
    expect((await POST(signedRequest(toOld))).status).toBe(202);
    expect(await rowCount(JSON.parse(toOld).messageId as string)).toBe(0);

    const toNew = makeBody({ to: `${newAlias}@${DOMAIN}` });
    expect((await POST(signedRequest(toNew))).status).toBe(202);
    expect(await rowCount(JSON.parse(toNew).messageId as string)).toBe(1);

    await revokeInboundAlias(user.id);
    const afterRevoke = makeBody({ to: `${newAlias}@${DOMAIN}` });
    expect((await POST(signedRequest(afterRevoke))).status).toBe(202);
    expect(await rowCount(JSON.parse(afterRevoke).messageId as string)).toBe(0);

    await db.user.delete({ where: { id: user.id } });
  });

  it("suspended 用户入站静默丢弃（202 零写入）", async () => {
    const user = await makeUser();
    const alias = await rotateInboundAlias(user.id);
    // users_suspended_reason CHECK：suspended 必须带 reason
    await db.user.update({
      where: { id: user.id },
      data: { status: "suspended", statusReason: "admin" },
    });

    const body = makeBody({ to: `${alias}@${DOMAIN}` });
    expect((await POST(signedRequest(body))).status).toBe(202);
    expect(await rowCount(JSON.parse(body).messageId as string)).toBe(0);

    await db.user.delete({ where: { id: user.id } });
  });

  it("别名维度超限返回 429 + Retry-After 且零写入", async () => {
    const user = await makeUser();
    const alias = await rotateInboundAlias(user.id);

    for (let i = 0; i < INBOUND_RATE_LIMITS.emailAlias.limit; i += 1) {
      await consumeRateLimits([withRateLimitKey(INBOUND_RATE_LIMITS.emailAlias, alias)]);
    }

    const body = makeBody({ to: `${alias}@${DOMAIN}` });
    const res = await POST(signedRequest(body));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).not.toBeNull();
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await rowCount(JSON.parse(body).messageId as string)).toBe(0);

    await db.rateLimitCounter.deleteMany({ where: { scope: { startsWith: "inbound:email" } } });
    await db.user.delete({ where: { id: user.id } });
  });
});
