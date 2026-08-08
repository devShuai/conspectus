import { describe, expect, it } from "vitest";

import { db } from "@/server/db";
import { consumeRateLimits, type RateLimitRule } from "./rate-limit";

const DISABLED = !process.env.TEST_DATABASE_URL;

function uniqueScope(label: string): string {
  return `test:${label}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
}

describe.skipIf(DISABLED)("PostgreSQL rate limits", () => {
  it("allows only the configured number under concurrent attempts", async () => {
    const scope = uniqueScope("concurrent");
    const rule: RateLimitRule = {
      scope,
      key: "same-account@example.com",
      limit: 3,
      windowMs: 60_000,
    };

    const results = await Promise.all(
      Array.from({ length: 10 }, () => consumeRateLimits([rule])),
    );
    expect(results.filter((result) => result.allowed)).toHaveLength(3);
    expect(results.filter((result) => !result.allowed)).toHaveLength(7);

    const row = await db.rateLimitCounter.findFirst({ where: { scope } });
    expect(row?.attemptCount).toBe(10);
    await db.rateLimitCounter.deleteMany({ where: { scope } });
  });

  it("resets at a new fixed window and never rolls back to an older window", async () => {
    const scope = uniqueScope("window");
    const rule: RateLimitRule = { scope, key: "198.51.100.7", limit: 1, windowMs: 60_000 };
    const firstWindow = new Date("2026-08-08T08:00:10.000Z");
    const secondWindow = new Date("2026-08-08T08:01:10.000Z");

    await expect(consumeRateLimits([rule], firstWindow)).resolves.toMatchObject({ allowed: true });
    await expect(consumeRateLimits([rule], secondWindow)).resolves.toMatchObject({ allowed: true });
    await expect(consumeRateLimits([rule], firstWindow)).resolves.toMatchObject({ allowed: false });

    const row = await db.rateLimitCounter.findFirst({ where: { scope } });
    expect(row?.windowStart).toEqual(new Date("2026-08-08T08:01:00.000Z"));
    expect(row?.attemptCount).toBe(2);
    await db.rateLimitCounter.deleteMany({ where: { scope } });
  });

  it("consumes IP and account dimensions in one result", async () => {
    const prefix = uniqueScope("dimensions");
    const ipRule: RateLimitRule = {
      scope: `${prefix}:ip`,
      key: "203.0.113.9",
      limit: 10,
      windowMs: 60_000,
    };
    const accountRule: RateLimitRule = {
      scope: `${prefix}:account`,
      key: "alice@example.com",
      limit: 1,
      windowMs: 60_000,
    };

    await expect(consumeRateLimits([ipRule, accountRule])).resolves.toMatchObject({ allowed: true });
    const denied = await consumeRateLimits([ipRule, accountRule]);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBeGreaterThan(0);

    await db.rateLimitCounter.deleteMany({ where: { scope: { startsWith: prefix } } });
  });
});
