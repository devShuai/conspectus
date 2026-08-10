import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

import type { LocalCollector, UsageReading } from "../types.js";
import { runCli, spawnCli } from "../exec.js";
import { registerCollector } from "./registry.js";
import { versionAtLeast } from "./runner.js";

const MIN_VERSION = "0.147.0";
/** 账号主限额的 bucket；`codex:5h` / `codex:weekly` 这类按时长命名的 binding 指的就是它。 */
const CANONICAL_LIMIT_ID = "codex";

interface RateLimitWindow {
  usedPercent?: unknown;
  windowDurationMins?: unknown;
  resetsAt?: unknown;
}

interface RateLimitBucket {
  limitId?: unknown;
  primary?: RateLimitWindow | null;
  secondary?: RateLimitWindow | null;
}

interface RateLimitResult {
  rateLimits?: RateLimitBucket | null;
  rateLimitsByLimitId?: Record<string, RateLimitBucket> | null;
}

interface UsageResult {
  summary?: { lifetimeTokens?: unknown } | null;
  dailyUsageBuckets?: Array<{ startDate?: unknown; tokens?: unknown }> | null;
}

export interface CodexAppServerReadings {
  rateLimits: Array<{
    limitId: string;
    slot: "primary" | "secondary";
    usedPercent: number;
    windowDurationMins: number;
    resetsAt: number;
  }>;
  lifetimeTokens: number | null;
}

export const codexCollector: LocalCollector = {
  id: "codex",
  displayName: "Codex Desktop / CLI",

  async detect(): Promise<boolean> {
    return (await resolveCodexExecutable()) !== null;
  },

  async collect(ctx): Promise<UsageReading[]> {
    const executable = await resolveCodexExecutable();
    if (!executable) throw new Error("not_installed: Codex Desktop or CLI executable not found");
    const readings = await readCodexAppServer(executable);
    return normalizeCodexReadings(readings, ctx.bindings, new Date().toISOString());
  },
};

export async function resolveCodexExecutable(): Promise<string | null> {
  const explicit = process.env.CONSPECTUS_CODEX_EXECUTABLE?.trim();
  const candidates = [
    ...(explicit ? [explicit] : []),
    "codex",
    ...(await pathCodexCandidates()),
    ...desktopCodexCandidates(),
  ];
  for (const candidate of [...new Set(candidates)]) {
    try {
      const output = await runCli(candidate, ["--version"], 5_000);
      const version = output.match(/\d+\.\d+\.\d+/)?.[0];
      if (version && versionAtLeast(version, MIN_VERSION)) return candidate;
    } catch {
      // WindowsApps aliases can resolve but deny direct launch; try bundled fallbacks.
    }
  }
  return null;
}

export function desktopCodexCandidates(): string[] {
  const candidates: string[] = [];
  if (process.platform === "darwin") {
    candidates.push("/Applications/Codex.app/Contents/Resources/codex");
  }
  if (process.platform === "win32") {
    const extensionRoot = resolve(homedir(), ".vscode", "extensions");
    try {
      const extensions = readdirSync(extensionRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.startsWith("openai.chatgpt-"))
        .map((entry) => entry.name)
        .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
      for (const extension of extensions) {
        candidates.push(
          resolve(extensionRoot, extension, "bin", "windows-x86_64", "codex.exe"),
        );
      }
    } catch {
      // VS Code extension not installed.
    }
    if (process.env.LOCALAPPDATA) {
      candidates.push(resolve(process.env.LOCALAPPDATA, "Microsoft", "WindowsApps", "codex.exe"));
    }
    if (process.env.APPDATA) {
      candidates.push(resolve(process.env.APPDATA, "npm", "codex.cmd"));
    }
  }
  return candidates.filter(existsSync);
}

async function pathCodexCandidates(): Promise<string[]> {
  if (process.platform !== "win32") return [];
  try {
    const output = await runCli("where.exe", ["codex.exe"]);
    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

export async function readCodexAppServer(
  executable: string,
  appServerArgs: string[] = ["app-server"],
  timeoutMs = 15_000,
): Promise<CodexAppServerReadings> {
  const child = spawnCli(executable, appServerArgs, { stdio: "pipe" });
  if (!child.stdin || !child.stdout) {
    child.kill();
    throw new Error("codex app-server stdio unavailable");
  }
  const lines = createInterface({ input: child.stdout });
  let terminalError: Error | null = null;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();

  const rejectPending = (error: Error) => {
    terminalError = error;
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  };
  child.once("error", () => rejectPending(new Error("codex app-server launch failed")));
  child.once("exit", (code) => {
    if (pending.size > 0) {
      rejectPending(new Error(`codex app-server exited before response (${code ?? "signal"})`));
    }
  });
  lines.on("line", (line) => {
    let message: { id?: unknown; result?: unknown; error?: unknown };
    try {
      message = JSON.parse(line) as { id?: unknown; result?: unknown; error?: unknown };
    } catch {
      return;
    }
    if (typeof message.id !== "number") return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error !== undefined) entry.reject(classifyAppServerError(message.error));
    else entry.resolve(message.result);
  });

  const send = (message: unknown) => {
    if (terminalError) throw terminalError;
    child.stdin!.write(`${JSON.stringify(message)}\n`);
  };
  const request = (id: number, method: string, params?: unknown): Promise<unknown> =>
    new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`codex app-server ${method} timed out`));
      }, timeoutMs);
      pending.set(id, { resolve: resolvePromise, reject, timer });
      send({ method, id, ...(params === undefined ? {} : { params }) });
    });

  try {
    await request(1, "initialize", {
      clientInfo: { name: "conspectus_collector", title: "Conspectus Collector", version: "0.1.0" },
    });
    send({ method: "initialized", params: {} });
    const [rateLimits, usage] = await Promise.allSettled([
      request(2, "account/rateLimits/read"),
      request(3, "account/usage/read"),
    ]);
    if (rateLimits.status === "rejected" && usage.status === "rejected") {
      const reasons = [rateLimits.reason, usage.reason];
      const authError = reasons.find(
        (reason) => reason instanceof Error && reason.message.startsWith("auth_required:"),
      );
      if (authError instanceof Error) throw authError;
      throw new Error("codex account usage methods unavailable");
    }
    return normalizeCodexAppServer(
      rateLimits.status === "fulfilled" ? rateLimits.value : null,
      usage.status === "fulfilled" ? usage.value : null,
    );
  } finally {
    for (const entry of pending.values()) clearTimeout(entry.timer);
    pending.clear();
    lines.close();
    child.kill("SIGTERM");
  }
}

export function normalizeCodexAppServer(
  rateLimitBody: unknown,
  usageBody: unknown,
): CodexAppServerReadings {
  const result = isRecord(rateLimitBody) ? (rateLimitBody as RateLimitResult) : {};
  const byId = isRecord(result.rateLimitsByLimitId) ? result.rateLimitsByLimitId : null;
  const buckets: Array<[string, RateLimitBucket]> = byId
    ? Object.entries(byId).filter((entry): entry is [string, RateLimitBucket] => isRecord(entry[1]))
    : isRecord(result.rateLimits)
      ? [[String(result.rateLimits.limitId ?? "codex"), result.rateLimits]]
      : [];
  const rateLimits: CodexAppServerReadings["rateLimits"] = [];
  for (const [key, bucket] of buckets) {
    const limitId = String(bucket.limitId ?? key);
    for (const slot of ["primary", "secondary"] as const) {
      const window = bucket[slot];
      if (!isRecord(window)) continue;
      const usedPercent = Number(window.usedPercent);
      const windowDurationMins = Number(window.windowDurationMins);
      const resetsAt = Number(window.resetsAt);
      if (
        !Number.isFinite(usedPercent) ||
        !Number.isFinite(windowDurationMins) ||
        !Number.isFinite(resetsAt) ||
        usedPercent < 0 ||
        windowDurationMins <= 0 ||
        resetsAt <= 0
      ) {
        continue;
      }
      rateLimits.push({
        limitId,
        slot,
        usedPercent: Math.min(usedPercent, 100),
        windowDurationMins,
        resetsAt,
      });
    }
  }
  const usage = isRecord(usageBody) ? (usageBody as UsageResult) : {};
  const lifetime = Number(usage.summary?.lifetimeTokens);
  return { rateLimits, lifetimeTokens: Number.isFinite(lifetime) && lifetime >= 0 ? lifetime : null };
}

export function normalizeCodexReadings(
  readings: CodexAppServerReadings,
  bindings: Array<{ bindingId: string; metric: string; kind: string; unit: string }>,
  capturedAt: string,
): UsageReading[] {
  const output: UsageReading[] = [];
  for (const window of readings.rateLimits) {
    const exactMetric = `codex:${window.limitId}:${window.slot}`;
    /*
     * duration 兜底只认规范 bucket（limitId === "codex"）。
     *
     * app-server 会同时返回多个 limitId 而窗口长度相同：实测账号上
     * `codex`(usedPercent=9) 与 `codex_bengalfox`(0) 都是 10080 分钟。此前两者都
     * 命中同一条 codex:weekly binding，一批里对同一 binding 推两条读数；两条
     * capturedAt 相同，ingest 在同刻并列时用 Snapshot UUID 决胜，而 UUID 是随机
     * 的 —— 于是真实的 9% 被 0% 顶掉纯属偶然，且偏向「以为还没用」这一侧。
     *
     * 其它 limitId 要采集就显式绑 `codex:<limitId>:<slot>`，语义明确、不会撞车。
     */
    const durationMetric =
      window.limitId !== CANONICAL_LIMIT_ID
        ? null
        : window.windowDurationMins === 300
          ? "codex:5h"
          : window.windowDurationMins === 7 * 24 * 60
            ? "codex:weekly"
            : null;
    const binding = bindings.find(
      (candidate) =>
        candidate.kind === "quota" &&
        (candidate.metric === exactMetric || candidate.metric === durationMetric),
    );
    if (!binding) continue;
    const periodEnd = new Date(window.resetsAt * 1000);
    output.push({
      bindingId: binding.bindingId,
      kind: "quota",
      metric: binding.metric,
      unit: binding.unit,
      usedValue: String(window.usedPercent),
      limitValue: "100",
      periodStart: new Date(periodEnd.getTime() - window.windowDurationMins * 60_000).toISOString(),
      periodEnd: periodEnd.toISOString(),
      capturedAt,
    });
  }
  const counter = bindings.find(
    (candidate) => candidate.kind === "counter" && candidate.metric === "codex:tokens",
  );
  if (counter && readings.lifetimeTokens !== null) {
    output.push({
      bindingId: counter.bindingId,
      kind: "counter",
      metric: counter.metric,
      unit: counter.unit,
      usedValue: String(readings.lifetimeTokens),
      capturedAt,
    });
  }
  return output;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function classifyAppServerError(value: unknown): Error {
  const message = isRecord(value) && typeof value.message === "string" ? value.message : "";
  if (/authentication required|not logged in|unauthorized/i.test(message)) {
    return new Error("auth_required: run `codex login`");
  }
  if (/method not found|unknown method|unsupported/i.test(message)) {
    return new Error("unavailable: Codex app-server account usage methods unsupported");
  }
  return new Error("codex app-server request failed");
}

registerCollector(codexCollector);
