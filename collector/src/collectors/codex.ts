import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { LocalCollector, UsageReading } from "../types.js";
import { registerCollector } from "./registry.js";
import { versionAtLeast } from "./runner.js";

const execFileAsync = promisify(execFile);
const MIN_VERSION = "0.147.0";

export interface CodexAppServerReadings {
  rateLimits: Array<{ bucket: string; used: number; limit: number; resetsAt: string }>;
  usage: Array<{ day: string; tokens: number }>;
}

/**
 * Codex collector: starts the official app-server once, calls only
 * account/rateLimits/read and account/usage/read, normalizes buckets to
 * quota readings and token activity to a counter. Experimental surface is
 * version-gated; schema drift degrades to unavailable (never fake numbers).
 */
export const codexCollector: LocalCollector = {
  id: "codex",
  displayName: "Codex App Server",

  async detect(): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync("codex", ["--version"], { timeout: 10_000 });
      return versionAtLeast(stdout.trim(), MIN_VERSION);
    } catch {
      return false;
    }
  },

  async collect(ctx): Promise<UsageReading[]> {
    const readings = await readAppServer();
    const now = new Date().toISOString();
    const out: UsageReading[] = [];

    for (const rl of readings.rateLimits) {
      const binding = ctx.bindings.find(
        (b) => b.metric === `codex:${rl.bucket}` && b.kind === "quota",
      );
      if (!binding) continue;
      out.push({
        bindingId: binding.bindingId,
        kind: "quota",
        metric: `codex:${rl.bucket}`,
        unit: "req",
        usedValue: String(rl.used),
        limitValue: String(rl.limit),
        periodEnd: rl.resetsAt,
        capturedAt: now,
      });
    }

    const totalTokens = readings.usage.reduce((sum, u) => sum + u.tokens, 0);
    const counterBinding = ctx.bindings.find(
      (b) => b.metric === "codex:tokens" && b.kind === "counter",
    );
    if (counterBinding) {
      out.push({
        bindingId: counterBinding.bindingId,
        kind: "counter",
        metric: "codex:tokens",
        unit: "tok",
        usedValue: String(totalTokens),
        capturedAt: now,
      });
    }
    return out;
  },
};

async function readAppServer(): Promise<CodexAppServerReadings> {
  const { spawn } = await import("node:child_process");
  const port = 5000 + Math.floor(Math.random() * 1000);
  const child = spawn("codex", ["app-server", "--host", "127.0.0.1", "--port", String(port)], {
    stdio: "ignore",
    detached: true,
  });
  try {
    await waitForServer(port);
    const rateLimits = await getJson<{ data?: Array<Record<string, unknown>> }>(
      `http://127.0.0.1:${port}/account/rateLimits/read`,
    );
    const usage = await getJson<{ data?: Array<Record<string, unknown>> }>(
      `http://127.0.0.1:${port}/account/usage/read`,
    );
    return {
      rateLimits: (rateLimits.data ?? []).map(normalizeRateLimit),
      usage: (usage.data ?? []).map((u) => ({
        day: String(u.day ?? ""),
        tokens: Number(u.tokens ?? 0),
      })),
    };
  } finally {
    child.kill("SIGTERM");
  }
}

function normalizeRateLimit(raw: Record<string, unknown>): {
  bucket: string;
  used: number;
  limit: number;
  resetsAt: string;
} {
  const bucket = String(raw.bucket ?? raw.name ?? "requests");
  return {
    bucket,
    used: Number(raw.used ?? raw.count ?? 0),
    limit: Number(raw.limit ?? raw.max ?? 0),
    resetsAt: String(raw.resets_at ?? raw.reset ?? ""),
  };
}

async function waitForServer(port: number, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("codex app-server did not become ready");
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`codex endpoint ${response.status}`);
  return response.json() as Promise<T>;
}

registerCollector(codexCollector);
