import { describe, expect, it } from "vitest";

import {
  clientIpFromRequest,
  emailRateLimitKey,
  isSameOriginAuthRequest,
} from "./http-security";

const APP_URL = new URL("https://conspectus.example");

describe("local auth HTTP security", () => {
  it("accepts an exact Origin or same-origin Referer", () => {
    expect(
      isSameOriginAuthRequest(
        new Request("https://conspectus.example/api/auth/local-login", {
          headers: { origin: "https://conspectus.example" },
        }),
        APP_URL,
      ),
    ).toBe(true);
    expect(
      isSameOriginAuthRequest(
        new Request("https://conspectus.example/api/auth/local-login", {
          headers: { referer: "https://conspectus.example/login?from=expired" },
        }),
        APP_URL,
      ),
    ).toBe(true);
  });

  it("rejects cross-origin, null, malformed and missing origin signals", () => {
    const invalidHeaders: HeadersInit[] = [
      { origin: "https://evil.example" },
      { origin: "null" },
      { origin: "not a URL" },
      { origin: "https://conspectus.example/forged-path" },
      { referer: "https://evil.example/login" },
      {},
    ];
    for (const headers of invalidHeaders) {
      expect(
        isSameOriginAuthRequest(
          new Request("https://conspectus.example/api/auth/local-login", { headers }),
          APP_URL,
        ),
      ).toBe(false);
    }
  });

  it("uses only syntactically valid proxy client addresses", () => {
    expect(
      clientIpFromRequest(
        new Request("https://conspectus.example", {
          headers: { "x-forwarded-for": "203.0.113.4, 10.0.0.2" },
        }),
      ),
    ).toBe("203.0.113.4");
    expect(
      clientIpFromRequest(
        new Request("https://conspectus.example", {
          headers: { "x-forwarded-for": "forged", "x-real-ip": "198.51.100.2" },
        }),
      ),
    ).toBe("unknown");
  });

  it("normalizes account keys and stabilizes malformed input", () => {
    expect(emailRateLimitKey(" Alice@EXAMPLE.com ")).toBe("alice@example.com");
    expect(emailRateLimitKey("not-an-email")).toBe("invalid:not-an-email");
    expect(emailRateLimitKey("  ")).toBe("invalid:missing");
  });
});
