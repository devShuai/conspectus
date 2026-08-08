import { createHash } from "node:crypto";

import { db } from "@/server/db";

export type RateLimitRule = {
  scope: string;
  key: string;
  limit: number;
  windowMs: number;
};

export type RateLimitResult = {
  allowed: boolean;
  retryAfterSeconds: number;
};

type CounterRow = {
  attemptCount: number;
  windowEndsAt: Date;
};

export const LOCAL_AUTH_RATE_LIMITS = {
  loginIp: { scope: "auth:local-login:ip", limit: 20, windowMs: 10 * 60_000 },
  loginAccount: { scope: "auth:local-login:account", limit: 10, windowMs: 10 * 60_000 },
  registerIp: { scope: "auth:local-register:ip", limit: 5, windowMs: 60 * 60_000 },
  registerAccount: { scope: "auth:local-register:account", limit: 3, windowMs: 60 * 60_000 },
  resetIp: { scope: "auth:password-reset:ip", limit: 10, windowMs: 30 * 60_000 },
  resetTarget: { scope: "auth:password-reset:target", limit: 5, windowMs: 30 * 60_000 },
} as const;

function fingerprint(scope: string, key: string): string {
  return createHash("sha256").update(scope).update("\0").update(key).digest("hex");
}

function assertRule(rule: RateLimitRule): void {
  if (!rule.scope || !rule.key || !Number.isSafeInteger(rule.limit) || rule.limit < 1) {
    throw new Error("invalid rate limit rule");
  }
  if (!Number.isSafeInteger(rule.windowMs) || rule.windowMs < 1_000) {
    throw new Error("invalid rate limit window");
  }
}

/**
 * Atomically consume every dimension in one PostgreSQL transaction. Delayed
 * requests from an older window increment the current row instead of rolling
 * its window backwards.
 */
export async function consumeRateLimits(
  rules: readonly RateLimitRule[],
  now?: Date,
): Promise<RateLimitResult> {
  if (rules.length === 0) throw new Error("at least one rate limit rule is required");
  rules.forEach(assertRule);

  const result = await db.$transaction(async (tx) => {
    const effectiveNow = now ?? (await tx.$queryRaw<Array<{ now: Date }>>`
      SELECT clock_timestamp() AS "now"
    `)[0]?.now;
    if (!effectiveNow) throw new Error("database clock query returned no row");

    const consumed: CounterRow[] = [];
    for (const rule of rules) {
      const windowStartMs =
        Math.floor(effectiveNow.getTime() / rule.windowMs) * rule.windowMs;
      const windowStart = new Date(windowStartMs);
      const windowEndsAt = new Date(windowStartMs + rule.windowMs);
      const keyHash = fingerprint(rule.scope, rule.key);
      const result = await tx.$queryRaw<CounterRow[]>`
        INSERT INTO "rate_limit_counters"
          ("scope", "keyHash", "windowStart", "windowEndsAt", "attemptCount")
        VALUES
          (${rule.scope}, ${keyHash}, ${windowStart}, ${windowEndsAt}, 1)
        ON CONFLICT ("scope", "keyHash") DO UPDATE SET
          "attemptCount" = CASE
            WHEN "rate_limit_counters"."windowStart" < EXCLUDED."windowStart" THEN 1
            ELSE "rate_limit_counters"."attemptCount" + 1
          END,
          "windowStart" = GREATEST(
            "rate_limit_counters"."windowStart",
            EXCLUDED."windowStart"
          ),
          "windowEndsAt" = GREATEST(
            "rate_limit_counters"."windowEndsAt",
            EXCLUDED."windowEndsAt"
          )
        RETURNING "attemptCount", "windowEndsAt"
      `;
      const row = result[0];
      if (!row) throw new Error("rate limit counter upsert returned no row");
      consumed.push(row);
    }
    return { consumed, effectiveNow };
  });

  let allowed = true;
  let retryAfterSeconds = 0;
  result.consumed.forEach((row, index) => {
    if (row.attemptCount <= rules[index].limit) return;
    allowed = false;
    retryAfterSeconds = Math.max(
      retryAfterSeconds,
      Math.max(
        1,
        Math.ceil((row.windowEndsAt.getTime() - result.effectiveNow.getTime()) / 1_000),
      ),
    );
  });
  return { allowed, retryAfterSeconds };
}

export function withRateLimitKey(
  definition: { scope: string; limit: number; windowMs: number },
  key: string,
): RateLimitRule {
  return { ...definition, key };
}
