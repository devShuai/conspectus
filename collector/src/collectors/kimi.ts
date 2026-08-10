import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { runCli } from "../exec.js";
import type { LocalCollector, UsageReading } from "../types.js";
import { ensureKimiAccessToken } from "./kimi-auth.js";
import { registerCollector } from "./registry.js";

export { ensureKimiAccessToken, readKimiAccessToken } from "./kimi-auth.js";

interface KimiUsageDetail {
  used?: unknown;
  limit?: unknown;
  resetTime?: unknown;
}

interface KimiUsagePayload {
  usage?: KimiUsageDetail;
  limits?: Array<{
    window?: { duration?: unknown; timeUnit?: unknown };
    detail?: KimiUsageDetail;
  }>;
}

export const kimiCodeCollector: LocalCollector = {
  id: "kimi-code",
  displayName: "Kimi Code",

  async detect(): Promise<boolean> {
    if (process.env.KIMI_CODE_API_KEY || existsSync(kimiCredentialPath())) return true;
    try {
      await runCli("kimi", ["--version"]);
      return true;
    } catch {
      return false;
    }
  },

  async collect(ctx): Promise<UsageReading[]> {
    const token = await resolveKimiAccessToken(Date.now());
    const baseUrl = (process.env.KIMI_CODE_BASE_URL ?? "https://api.kimi.com/coding/v1").replace(
      /\/+$/,
      "",
    );
    const response = await fetch(`${baseUrl}/usages`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 401 || response.status === 403) {
      throw new Error("auth_required: run `kimi login` or set KIMI_CODE_API_KEY");
    }
    if (!response.ok) throw new Error(`kimi usage HTTP ${response.status}`);
    return parseKimiUsage(await response.json(), ctx.bindings, new Date().toISOString());
  },
};

export function parseKimiUsage(
  body: unknown,
  bindings: Array<{ bindingId: string; metric: string; kind: string; unit: string }>,
  capturedAt: string,
): UsageReading[] {
  if (!isRecord(body)) throw new Error("unavailable: Kimi usage schema drift");
  const payload = body as KimiUsagePayload;
  const readings: UsageReading[] = [];

  appendKimiReading(readings, bindings, "kimi:weekly", payload.usage, capturedAt, 7 * 24 * 60);
  const fiveHour = Array.isArray(payload.limits)
    ? payload.limits.find((item) => isRecord(item) && isFiveHourWindow(item.window))?.detail
    : undefined;
  appendKimiReading(readings, bindings, "kimi:5h", fiveHour, capturedAt, 5 * 60);

  if (readings.length === 0) {
    throw new Error("unavailable: Kimi usage has no weekly or 5-hour quota");
  }
  return readings;
}

async function resolveKimiAccessToken(nowMs: number): Promise<string> {
  const dedicated = process.env.KIMI_CODE_API_KEY?.trim();
  if (dedicated) return dedicated;
  return ensureKimiAccessToken(kimiCredentialPath(), nowMs);
}

function kimiCredentialPath(): string {
  return (
    process.env.KIMI_CODE_CREDENTIALS_FILE ??
    resolve(homedir(), ".kimi-code", "credentials", "kimi-code.json")
  );
}

function appendKimiReading(
  output: UsageReading[],
  bindings: Array<{ bindingId: string; metric: string; kind: string; unit: string }>,
  metric: string,
  detail: KimiUsageDetail | undefined,
  capturedAt: string,
  durationMinutes: number,
): void {
  const binding = bindings.find((candidate) => candidate.metric === metric && candidate.kind === "quota");
  const used = toDecimal(detail?.used);
  const limit = toDecimal(detail?.limit);
  if (!binding || used === null || limit === null || Number(limit) <= 0) return;
  const periodEnd = typeof detail?.resetTime === "string" ? detail.resetTime : undefined;
  const endMs = periodEnd ? Date.parse(periodEnd) : Number.NaN;
  output.push({
    bindingId: binding.bindingId,
    kind: "quota",
    metric,
    unit: binding.unit,
    usedValue: used,
    limitValue: limit,
    periodStart: Number.isNaN(endMs)
      ? undefined
      : new Date(endMs - durationMinutes * 60_000).toISOString(),
    periodEnd,
    capturedAt,
  });
}

function isFiveHourWindow(window: { duration?: unknown; timeUnit?: unknown } | undefined): boolean {
  if (!window) return false;
  return (
    (Number(window.duration) === 300 && window.timeUnit === "TIME_UNIT_MINUTE") ||
    (Number(window.duration) === 5 && window.timeUnit === "TIME_UNIT_HOUR")
  );
}

function toDecimal(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? String(value) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

registerCollector(kimiCodeCollector);
