import type { LocalCollector, UsageReading } from "../types.js";
import { registerCollector } from "./registry.js";

interface RemainsResponse {
  status?: number;
  total?: number | string;
  remaining?: number | string;
  used_count?: number | string;
  current_interval_usage_count?: number | string;
  weekly_usage_count?: number | string;
  usage_percentage?: number | string;
  reset_at?: string;
}

/**
 * MiniMax Coding Plan collector (EXPERIMENTAL, design §7.4):
 * community-cross-validated `coding_plan/remains` (intl) / `token_plan/remains` (CN).
 * Community implementations treat usage counts as REMAINING; we compute
 * used = total - remaining and also accept a percentage variant.
 * Opt-in only (experimental), never logs response bodies, and the cash
 * balance stays on the manual channel.
 */
export const minimaxCollector: LocalCollector = {
  id: "minimax-coding-plan",
  displayName: "MiniMax Coding Plan (experimental)",

  async detect(): Promise<boolean> {
    // requires the opt-in env + a locally stored key
    return process.env.CONSPECTUS_MINIMAX_ENABLED === "true" && !!process.env.MINIMAX_API_KEY;
  },

  async collect(ctx): Promise<UsageReading[]> {
    const apiKey = process.env.MINIMAX_API_KEY;
    const host = process.env.MINIMAX_HOST ?? "api.minimax.io";
    const path = host.includes("minimaxi") || host.includes("minimax.io")
      ? "/v1/coding_plan/remains"
      : "/v1/token_plan/remains";

    const response = await fetch(`https://${host}${path}`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`minimax remains ${response.status}`); // no body in logs
    }
    const body = (await response.json()) as RemainsResponse;
    if (body.status !== 1 && body.status !== 2 && body.status !== 3) {
      throw new Error("unavailable: unexpected status code");
    }
    const total = toNumber(body.total);
    const remaining = toNumber(body.remaining ?? body.current_interval_usage_count ?? body.weekly_usage_count);
    if (total === null || remaining === null) {
      throw new Error("unavailable: schema drift");
    }
    const used = Math.max(0, total - remaining);
    const now = new Date().toISOString();
    const out: UsageReading[] = [];
    for (const metric of ["minimax:5h", "minimax:weekly"]) {
      const binding = ctx.bindings.find((b) => b.metric === metric && b.kind === "quota");
      if (!binding) continue;
      out.push({
        bindingId: binding.bindingId,
        kind: "quota",
        metric,
        unit: "req",
        usedValue: String(used),
        limitValue: String(total),
        periodEnd: body.reset_at,
        capturedAt: now,
      });
    }
    return out;
  },
};

function toNumber(value: number | string | undefined): number | null {
  if (value === undefined || value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

registerCollector(minimaxCollector);
