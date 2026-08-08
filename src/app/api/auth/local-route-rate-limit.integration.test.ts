import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadAppUrl } from "@/server/auth/config";
import { db } from "@/server/db";
import { POST as login } from "./local-login/route";
import { POST as register } from "./local-register/route";
import { POST as resetPassword } from "./password-reset/route";

const DISABLED = !process.env.TEST_DATABASE_URL;

function request(path: string, ip: string, fields: Record<string, string>): NextRequest {
  return new NextRequest(new URL(path, loadAppUrl()), {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: loadAppUrl().origin,
      "x-forwarded-for": ip,
    },
    body: new URLSearchParams(fields),
  });
}

describe.skipIf(DISABLED)("local auth route rate limits", () => {
  // 本地端点在默认 certus 模式下 404（#97）；本组用例针对 local 路由本身
  beforeEach(() => vi.stubEnv("AUTH_MODE", "both"));
  afterEach(async () => {
    vi.unstubAllEnvs();
    await db.rateLimitCounter.deleteMany({
      where: { scope: { startsWith: "auth:" } },
    });
  });

  it("limits login by normalized account across attempts", async () => {
    const email = `missing-${Date.now()}@example.com`;
    for (let attempt = 0; attempt < 10; attempt++) {
      const response = await login(
        request("/api/auth/local-login", `203.0.113.${attempt + 1}`, {
          email: attempt % 2 === 0 ? email.toUpperCase() : email,
          password: "wrong-password-123",
        }),
      );
      expect(response.status).toBe(401);
    }

    const denied = await login(
      request("/api/auth/local-login", "203.0.113.200", {
        email,
        password: "wrong-password-123",
      }),
    );
    expect(denied.status).toBe(429);
    expect(Number(denied.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("limits registration by normalized account before password hashing", async () => {
    const previous = process.env.LOCAL_REGISTRATION_ENABLED;
    process.env.LOCAL_REGISTRATION_ENABLED = "false";
    const email = `register-${Date.now()}@example.com`;
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const response = await register(
          request("/api/auth/local-register", `198.51.100.${attempt + 1}`, {
            email: attempt % 2 === 0 ? email.toUpperCase() : email,
            password: "correct-horse-battery-9!",
          }),
        );
        expect(response.status).toBe(404);
      }

      const denied = await register(
        request("/api/auth/local-register", "198.51.100.200", {
          email,
          password: "correct-horse-battery-9!",
        }),
      );
      expect(denied.status).toBe(429);
    } finally {
      if (previous === undefined) delete process.env.LOCAL_REGISTRATION_ENABLED;
      else process.env.LOCAL_REGISTRATION_ENABLED = previous;
    }
  });

  it("limits password-reset confirmation by token across source IPs", async () => {
    const token = `invalid-${Date.now()}`;
    for (let attempt = 0; attempt < 5; attempt++) {
      const response = await resetPassword(
        request("/api/auth/password-reset", `192.0.2.${attempt + 1}`, {
          token,
          password: "correct-horse-battery-9!",
        }),
      );
      expect(response.status).toBe(400);
    }

    const denied = await resetPassword(
      request("/api/auth/password-reset", "192.0.2.200", {
        token,
        password: "correct-horse-battery-9!",
      }),
    );
    expect(denied.status).toBe(429);
  });
});
