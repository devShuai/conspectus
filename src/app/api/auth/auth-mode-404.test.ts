import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest, type NextResponse } from "next/server";

/**
 * 端点模式闸门（§7.1 / #97）：功能关闭时返回 404 而不是隐藏入口。
 * 闸门在限流、同源校验与 DB 之前执行，因此不需要数据库夹具。
 */

type Handler = (request: NextRequest) => Promise<NextResponse>;
type RouteModule = { GET?: Handler; POST?: Handler };

function requestFor(method: "GET" | "POST", url: string): NextRequest {
  return new NextRequest(url, { method });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("local endpoints 404 under AUTH_MODE=certus", () => {
  it.each([
    ["local-login", () => import("./local-login/route"), "POST"],
    ["local-register", () => import("./local-register/route"), "POST"],
    ["password-reset", () => import("./password-reset/route"), "POST"],
    ["request-verification", () => import("./request-verification/route"), "POST"],
    ["verify-email", () => import("./verify-email/route"), "GET"],
  ] as const)("%s", async (name, load, method) => {
    vi.stubEnv("AUTH_MODE", "certus");
    const route = (await load()) as RouteModule;
    const handler = route[method];
    if (!handler) throw new Error(`${name} has no ${method} handler`);
    const url =
      name === "verify-email"
        ? `http://localhost/api/auth/${name}?token=x`
        : `http://localhost/api/auth/${name}`;
    const response = await handler(requestFor(method, url));
    expect(response.status).toBe(404);
  });
});

describe("certus endpoints 404 under AUTH_MODE=local", () => {
  it.each([
    ["certus/start", () => import("./certus/start/route"), "GET"],
    ["certus/callback", () => import("./certus/callback/route"), "GET"],
    ["certus/logout", () => import("./certus/logout/route"), "POST"],
    ["backchannel-logout", () => import("./backchannel-logout/route"), "POST"],
  ] as const)("%s", async (name, load, method) => {
    vi.stubEnv("AUTH_MODE", "local");
    const route = (await load()) as RouteModule;
    const handler = route[method];
    if (!handler) throw new Error(`${name} has no ${method} handler`);
    const response = await handler(requestFor(method, `http://localhost/api/auth/${name}`));
    expect(response.status).toBe(404);
  });
});
