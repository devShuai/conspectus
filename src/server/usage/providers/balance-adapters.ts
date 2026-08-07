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
  return listProviders().filter((p) => ['deepseek','kimi','xai'].includes(p.id));
}
