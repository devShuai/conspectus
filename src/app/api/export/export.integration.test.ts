import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import { db } from "@/server/db";
import { SESSION_COOKIE_NAME } from "@/server/auth/cookies";
import {
  createReauthTransaction,
  verifyReauthTransaction,
} from "@/server/auth/reauth";
import { createPersistentSession } from "@/server/auth/session-db";
import { SUBSCRIPTION_CSV_COLUMNS } from "@/server/billing/export";

import { GET } from "./route";

const DISABLED = !process.env.TEST_DATABASE_URL;

function unique(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function makeUser() {
  return db.user.create({
    data: {
      certusSub: unique("export-sub"),
      certusLinkStatus: "active",
      lastStatusSyncedAt: new Date(),
    },
  });
}

function exportRequest(token: string | null, query: string): NextRequest {
  return new NextRequest(`http://127.0.0.1:3000/api/export?${query}`, {
    headers: token ? { cookie: `${SESSION_COOKIE_NAME}=${token}` } : {},
  });
}

async function verifiedReauth(userId: string, sessionId: string): Promise<string> {
  const handle = await createReauthTransaction({
    userId,
    sessionId,
    action: "export",
    targetPath: "/settings/data",
  });
  await verifyReauthTransaction({
    token: handle.token,
    sessionId,
    userId,
    action: "export",
  });
  return handle.token;
}

describe.skipIf(DISABLED)("GET /api/export (#111)", () => {
  it("rejects unauthenticated and un-reauthed requests", async () => {
    const user = await makeUser();
    const session = await createPersistentSession({
      userId: user.id,
      authMethod: "certus",
    });

    const anonymous = await GET(exportRequest(null, "entity=subscriptions"));
    expect(anonymous.status).toBe(401);

    const noReauth = await GET(exportRequest(session.token, "entity=subscriptions"));
    expect(noReauth.status).toBe(428);

    const handle = await createReauthTransaction({
      userId: user.id,
      sessionId: session.sessionId,
      action: "export",
      targetPath: "/settings/data",
    });
    // 未 verify 的 reauth 不可消费
    const unverified = await GET(
      exportRequest(session.token, `entity=subscriptions&reauth=${handle.token}`),
    );
    expect(unverified.status).toBe(403);

    await db.user.delete({ where: { id: user.id } });
  });

  it("streams the §7.7 subscription column set with vendor/category/payment_method names", async () => {
    const user = await makeUser();
    const other = await makeUser();
    const session = await createPersistentSession({
      userId: user.id,
      authMethod: "certus",
    });
    const vendor = await db.vendor.create({
      data: {
        slug: unique("acme"),
        name: "Acme Cloud",
        category: "cloud",
        userId: user.id,
      },
    });
    const paymentMethod = await db.paymentMethod.create({
      data: { userId: user.id, label: "招行信用卡", kind: "credit_card" },
    });
    await db.subscription.create({
      data: {
        userId: user.id,
        vendorId: vendor.id,
        paymentMethodId: paymentMethod.id,
        name: "Acme, Pro \"+1\"",
        planName: "Pro",
        status: "active",
        price: 99.5,
        currency: "CNY",
        billingCycle: "monthly",
        anchorDay: 15,
        startedAt: new Date("2026-01-15T00:00:00Z"),
        autoRenew: true,
        tags: ["work", "云"],
        notes: "line1\nline2",
      },
    });
    // 其他租户的数据绝不能出现在导出里
    await db.subscription.create({
      data: {
        userId: other.id,
        name: "NotMine",
        status: "active",
        price: 1,
        currency: "USD",
        billingCycle: "monthly",
        startedAt: new Date("2026-01-01T00:00:00Z"),
      },
    });

    const reauth = await verifiedReauth(user.id, session.sessionId);
    const response = await GET(
      exportRequest(session.token, `entity=subscriptions&reauth=${reauth}`),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/csv");

    const bytes = new Uint8Array(await response.arrayBuffer());
    // BOM 字节必须在流里（text() 解码会吞掉 BOM，不能直接断言字符）
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const body = new TextDecoder().decode(bytes.subarray(3));
    const lines = body.split("\r\n").filter((l) => l.length > 0);
    expect(lines[0]).toBe(SUBSCRIPTION_CSV_COLUMNS.join(","));
    expect(lines).toHaveLength(2); // header + 仅本租户一行
    expect(lines[1]).toContain('"Acme, Pro ""+1"""'); // 转义
    expect(lines[1]).toContain("Acme Cloud");
    expect(lines[1]).toContain("cloud");
    expect(lines[1]).toContain("招行信用卡");
    expect(lines[1]).toContain("work;云");
    expect(lines[1]).toContain('"line1\nline2"');
    expect(lines[1]).not.toContain("NotMine");

    await db.user.delete({ where: { id: user.id } });
    await db.user.delete({ where: { id: other.id } });
  });

  it("pages large result sets via keyset cursor without losing rows", async () => {
    const user = await makeUser();
    const session = await createPersistentSession({
      userId: user.id,
      authMethod: "certus",
    });
    const TOTAL = 505; // > PAGE_SIZE，至少翻一页
    await db.subscription.createMany({
      data: Array.from({ length: TOTAL }, (_, i) => ({
        userId: user.id,
        name: `bulk-${i}`,
        status: "active" as const,
        price: 1,
        currency: "CNY",
        billingCycle: "monthly" as const,
        startedAt: new Date("2026-01-01T00:00:00Z"),
      })),
    });

    const reauth = await verifiedReauth(user.id, session.sessionId);
    const response = await GET(
      exportRequest(session.token, `entity=subscriptions&reauth=${reauth}`),
    );
    expect(response.status).toBe(200);
    const body = await response.text();
    const lines = body.split("\r\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(TOTAL + 1);
    const names = new Set(lines.slice(1).map((l) => l.split(",")[0]));
    expect(names.size).toBe(TOTAL); // 无漏无重

    await db.user.delete({ where: { id: user.id } });
  }, 60_000);
});
