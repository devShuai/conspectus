import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { runCli } from "../exec.js";
import type { LocalCollector, UsageReading } from "../types.js";
import { registerCollector } from "./registry.js";

interface KimiCredentialWire {
  access_token?: unknown;
  expires_at?: unknown;
}

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
    const token = resolveKimiAccessToken(Date.now());
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
    ? payload.limits.find((item) => isFiveHourWindow(item.window))?.detail
    : undefined;
  appendKimiReading(readings, bindings, "kimi:5h", fiveHour, capturedAt, 5 * 60);

  if (readings.length === 0) {
    throw new Error("unavailable: Kimi usage has no weekly or 5-hour quota");
  }
  return readings;
}

export function readKimiAccessToken(path: string, nowMs: number): string {
  let parsed: KimiCredentialWire;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as KimiCredentialWire;
  } catch {
    throw new Error("auth_required: Kimi Code credentials not found");
  }
  const accessToken = typeof parsed.access_token === "string" ? parsed.access_token : "";
  const expiresAt = Number(parsed.expires_at);
  if (!accessToken) throw new Error("auth_required: Kimi Code access token missing");
  // Kimi Code 官方格式是 Unix seconds。采集器只读，绝不代替 Kimi 刷新/轮换 token。
  if (!Number.isFinite(expiresAt) || expiresAt * 1000 <= nowMs + 30_000) {
    throw new Error("auth_expired: run `kimi login` or set KIMI_CODE_API_KEY");
  }
  return accessToken;
}

function resolveKimiAccessToken(nowMs: number): string {
  const dedicated = process.env.KIMI_CODE_API_KEY?.trim();
  if (dedicated) return dedicated;
  return readKimiAccessToken(kimiCredentialPath(), nowMs);
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
