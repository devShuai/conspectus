import {
  listProviders,
  registerProvider,
  ProviderError,
  type DecryptedCredential,
  type SyncContext,
  type UsageProvider,
  type UsageReadingLike,
} from "../sync";

const TIMEOUT_MS = 15_000;
const MINIMAX_ENDPOINTS = [
  "https://api.minimax.io/v1/api/openplatform/coding_plan/remains",
  "https://www.minimax.io/v1/api/openplatform/coding_plan/remains",
] as const;

async function fetchJson(url: string, secret: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${secret}`, accept: "application/json" },
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403) {
      throw new ProviderError("auth", "unauthorized");
    }
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get("retry-after"));
      const err = new ProviderError("rate_limited", "rate limited") as ProviderError & {
        retryAfterMs?: number;
      };
      if (Number.isFinite(retryAfter)) err.retryAfterMs = retryAfter * 1000;
      throw err;
    }
    if (response.status >= 500) {
      throw new ProviderError("network", `upstream ${response.status}`);
    }
    if (!response.ok) {
      throw new ProviderError("network", `upstream ${response.status}`);
    }
    return response.json();
  } catch (cause) {
    if (cause instanceof ProviderError) throw cause;
    throw new ProviderError("network", "timeout_or_network");
  } finally {
    clearTimeout(timer);
  }
}

/** DeepSeek: GET /user/balance (M0 E2E GO). Balance strings → Decimal-safe strings. */
registerProvider({
  id: "deepseek",
  displayName: "DeepSeek",
  authKind: "api_key",
  async fetchUsage(cred: DecryptedCredential, ctx: SyncContext): Promise<UsageReadingLike[]> {
    const body = (await fetchJson("https://api.deepseek.com/user/balance", cred.secret)) as {
      balance_infos?: Array<{ currency: string; total_balance: string }>;
    };
    const infos = body.balance_infos ?? [];
    const now = new Date().toISOString();
    return infos
      .filter((info) => typeof info.total_balance === "string")
      .map((info) => {
        const binding = ctx.allowedBindings.find(
          (b) => b.metric === "credit" && b.unit === info.currency,
        );
        if (!binding) return null;
        return {
          bindingId: binding.bindingId,
          kind: "balance" as const,
          metric: "credit",
          unit: info.currency,
          remainingValue: info.total_balance,
          capturedAt: now,
        };
      })
      .filter((r) => r !== null);
  },
});

interface MiniMaxRemain {
  start_time?: number | string;
  end_time?: number | string;
  current_interval_total_count?: number | string;
  current_interval_usage_count?: number | string;
  current_weekly_total_count?: number | string;
  current_weekly_usage_count?: number | string;
  weekly_start_time?: number | string;
  weekly_end_time?: number | string;
  model_name?: string;
}

interface MiniMaxRemainsResponse {
  base_resp?: { status_code?: number | string };
  model_remains?: MiniMaxRemain[];
}

/**
 * MiniMax Coding Plan 的 `*_usage_count` 实际是剩余次数，而不是已用次数。
 * 此协议语义与 MIT 项目 opgginc/opencode-bar 的 provider + fixture 交叉验证。
 */
export function parseMiniMaxCodingPlan(
  body: unknown,
  ctx: SyncContext,
  capturedAt: string,
): UsageReadingLike[] {
  const response = body as MiniMaxRemainsResponse;
  if (toFiniteNumber(response.base_resp?.status_code) !== 0) {
    throw new ProviderError("invalid", "unexpected MiniMax status");
  }
  const rows = (response.model_remains ?? []).filter(hasMiniMaxQuota);
  const row = rows.sort(compareMiniMaxRows).at(-1);
  if (!row) {
    throw new ProviderError("invalid", "missing MiniMax quota data");
  }

  const readings: UsageReadingLike[] = [];
  appendMiniMaxWindow(readings, ctx, row, {
    metric: "minimax:5h",
    total: row.current_interval_total_count,
    remaining: row.current_interval_usage_count,
    start: row.start_time,
    end: row.end_time,
    capturedAt,
  });
  appendMiniMaxWindow(readings, ctx, row, {
    metric: "minimax:weekly",
    total: row.current_weekly_total_count,
    remaining: row.current_weekly_usage_count,
    start: row.weekly_start_time,
    end: row.weekly_end_time,
    capturedAt,
  });
  if (readings.length === 0) {
    throw new ProviderError("invalid", "missing MiniMax quota windows");
  }
  return readings;
}

registerProvider({
  id: "minimax-coding-plan",
  displayName: "MiniMax Coding Plan",
  authKind: "api_key",
  async fetchUsage(cred: DecryptedCredential, ctx: SyncContext): Promise<UsageReadingLike[]> {
    let body: unknown;
    for (const [index, endpoint] of MINIMAX_ENDPOINTS.entries()) {
      try {
        body = await fetchJson(endpoint, cred.secret);
        break;
      } catch (cause) {
        if (
          !(cause instanceof ProviderError) ||
          cause.kind !== "network" ||
          index === MINIMAX_ENDPOINTS.length - 1
        ) {
          throw cause;
        }
      }
    }
    return parseMiniMaxCodingPlan(body, ctx, new Date().toISOString());
  },
});

function appendMiniMaxWindow(
  output: UsageReadingLike[],
  ctx: SyncContext,
  _row: MiniMaxRemain,
  window: {
    metric: string;
    total: number | string | undefined;
    remaining: number | string | undefined;
    start: number | string | undefined;
    end: number | string | undefined;
    capturedAt: string;
  },
): void {
  const binding = ctx.allowedBindings.find(
    (candidate) => candidate.metric === window.metric && candidate.kind === "quota",
  );
  const total = toFiniteNumber(window.total);
  const remaining = toFiniteNumber(window.remaining);
  if (!binding || total === null || remaining === null || total <= 0) return;
  const clampedRemaining = Math.min(Math.max(remaining, 0), total);
  output.push({
    bindingId: binding.bindingId,
    kind: "quota",
    metric: window.metric,
    unit: binding.unit,
    usedValue: String(total - clampedRemaining),
    limitValue: String(total),
    periodStart: millisecondsToIso(window.start),
    periodEnd: millisecondsToIso(window.end),
    capturedAt: window.capturedAt,
  });
}

function hasMiniMaxQuota(row: MiniMaxRemain): boolean {
  return (
    (toFiniteNumber(row.current_interval_total_count) ?? 0) > 0 ||
    (toFiniteNumber(row.current_weekly_total_count) ?? 0) > 0
  );
}

function compareMiniMaxRows(left: MiniMaxRemain, right: MiniMaxRemain): number {
  const utilization = (row: MiniMaxRemain): number => {
    const pairs = [
      [row.current_interval_total_count, row.current_interval_usage_count],
      [row.current_weekly_total_count, row.current_weekly_usage_count],
    ];
    return Math.max(
      ...pairs.map(([totalValue, remainingValue]) => {
        const total = toFiniteNumber(totalValue);
        const remaining = toFiniteNumber(remainingValue);
        return total && remaining !== null ? (total - Math.min(Math.max(remaining, 0), total)) / total : 0;
      }),
    );
  };
  const difference = utilization(left) - utilization(right);
  if (difference !== 0) return difference;
  const quotaScore = (row: MiniMaxRemain) =>
    Math.max(
      toFiniteNumber(row.current_interval_total_count) ?? 0,
      toFiniteNumber(row.current_weekly_total_count) ?? 0,
    );
  const scoreDifference = quotaScore(left) - quotaScore(right);
  if (scoreDifference !== 0) return scoreDifference;
  return String(left.model_name ?? "").localeCompare(String(right.model_name ?? ""));
}

function toFiniteNumber(value: number | string | undefined): number | null {
  if (value === undefined) return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function millisecondsToIso(value: number | string | undefined): string | undefined {
  const milliseconds = toFiniteNumber(value);
  if (milliseconds === null || milliseconds <= 0) return undefined;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** Kimi/Moonshot: balance endpoints per official contract; host must match key type. */
registerProvider({
  id: "kimi",
  displayName: "Kimi (Moonshot)",
  authKind: "api_key",
  async fetchUsage(cred: DecryptedCredential, ctx: SyncContext): Promise<UsageReadingLike[]> {
    const scopes = cred.scopes;
    const host: string = scopes.includes("kimi:international") ? "api.moonshot.ai" : "api.moonshot.cn";
    const body = (await fetchJson(`https://${host}/v1/users/me/balance`, cred.secret)) as {
      data?: { available_balance?: number; currency?: string };
    };
    const data = body.data;
    if (!data || typeof data.available_balance !== "number") {
      throw new ProviderError("invalid", "unexpected balance schema");
    }
    const now = new Date().toISOString();
    return ctx.allowedBindings
      .filter((b: SyncContext["allowedBindings"][number]) => b.metric === "credit")
      .map((binding: SyncContext["allowedBindings"][number]) => ({
        bindingId: binding.bindingId,
        kind: "balance" as const,
        metric: "credit",
        unit: data.currency ?? "CNY",
        remainingValue: String(data.available_balance),
        capturedAt: now,
      }));
  },
});

/** xAI: Management API (team prepaid balance); NEVER the inference API key. */
registerProvider({
  id: "xai",
  displayName: "xAI API",
  authKind: "api_key",
  async fetchUsage(cred: DecryptedCredential, ctx: SyncContext): Promise<UsageReadingLike[]> {
    const scopes = cred.scopes;
    const teamId = scopes.find((s: string) => s.startsWith("xai:team:"))?.slice("xai:team:".length);
    if (!teamId) {
      throw new ProviderError("auth", "xai management key requires team id");
    }
    const body = (await fetchJson(
      `https://management-api.x.ai/v1/teams/${teamId}/prepaid`,
      cred.secret,
    )) as { data?: { remaining?: string; currency?: string } };
    const data = body.data;
    if (!data || typeof data.remaining !== "string") {
      throw new ProviderError("invalid", "unexpected prepaid schema");
    }
    const now = new Date().toISOString();
    return ctx.allowedBindings
      .filter((b: SyncContext["allowedBindings"][number]) => b.metric === "credit")
      .map((binding: SyncContext["allowedBindings"][number]) => ({
        bindingId: binding.bindingId,
        kind: "balance" as const,
        metric: "credit",
        unit: data.currency ?? "USD",
        remainingValue: data.remaining,
        capturedAt: now,
      }));
  },
});


export function listBalanceAdapters(): UsageProvider[] {
  return listProviders().filter((p) =>
    ["deepseek", "kimi", "minimax-coding-plan", "xai"].includes(p.id),
  );
}
