import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// 本地端点在默认 certus 模式下 404（#97）；本组用例针对 local 路由本身
beforeEach(() => vi.stubEnv("AUTH_MODE", "both"));

import { POST as login } from "./local-login/route";
import { POST as register } from "./local-register/route";
import { POST as resetPassword } from "./password-reset/route";

function crossOriginRequest(path: string): NextRequest {
  return new NextRequest(`http://127.0.0.1:3000${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: "https://evil.example",
    },
    body: new URLSearchParams({
      email: "alice@example.com",
      password: "correct-horse-battery-9!",
      token: "invalid-token",
    }),
  });
}

describe("local auth route CSRF", () => {
  it.each([
    ["login", login, "/api/auth/local-login"],
    ["register", register, "/api/auth/local-register"],
    ["password reset", resetPassword, "/api/auth/password-reset"],
  ] as const)("rejects cross-origin %s before processing credentials", async (_name, route, path) => {
    const response = await route(crossOriginRequest(path));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_origin" },
    });
  });
});
