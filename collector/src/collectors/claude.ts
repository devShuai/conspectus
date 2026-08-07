import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

import type { LocalCollector, UsageReading } from "../types.js";
import { registerCollector } from "./registry.js";
import { versionAtLeast } from "./runner.js";

const MIN_VERSION = "2.0.0";
const SETTINGS_CANDIDATES = [
  resolve(homedir(), ".claude", "settings.json"),
];

interface ClaudeStatusLine {
  rate_limits?: {
    five_hour?: { used_percentage?: number; resets_at?: string };
    seven_day?: { used_percentage?: number; resets_at?: string };
  };
}

/**
 * Claude Code collector: reads ONLY the official status-line fields
 * (5h/7d used_percentage + resets_at). Never parses /usage text or
 * transcripts; missing fields / non-Pro / auth failure → unavailable.
 * Feature gate stays off until real-OAuth E2E (functional flag).
 */
export const claudeCollector: LocalCollector = {
  id: "claude-code",
  displayName: "Claude Code status line",

  async detect(): Promise<boolean> {
    try {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const { stdout } = await promisify(execFile)("claude", ["--version"], { timeout: 10_000 });
      return versionAtLeast(String(stdout).trim(), MIN_VERSION);
    } catch {
      return false;
    }
  },

  async collect(ctx): Promise<UsageReading[]> {
    if (process.env.CONSPECTUS_CLAUDE_ENABLED !== "true") {
      throw new Error("unavailable: claude collector feature gate off (needs real-OAuth E2E)");
    }
    const status = readStatusLine();
    if (!status?.rate_limits) {
      throw new Error("unavailable: no rate_limits in status line (non-Pro or not captured)");
    }
    const now = new Date().toISOString();
    const out: UsageReading[] = [];

    for (const [window, key] of [
      ["five_hour", "codex"], // placeholder replaced below
      ["seven_day", "codex"],
    ] as const) {
      void window;
      void key;
    }
    for (const window of ["five_hour", "seven_day"] as const) {
      const rl = status.rate_limits[window];
      if (!rl || typeof rl.used_percentage !== "number") continue; // independent degradation
      const metric = `claude:${window}`;
      const binding = ctx.bindings.find((b) => b.metric === metric && b.kind === "quota");
      if (!binding) continue;
      const pct = Math.min(Math.max(rl.used_percentage, 0), 100);
      out.push({
        bindingId: binding.bindingId,
        kind: "quota",
        metric,
        unit: "%",
        usedValue: String(pct),
        limitValue: "100",
        periodEnd: rl.resets_at,
        capturedAt: now,
      });
    }
    return out;
  },
};

function readStatusLine(): ClaudeStatusLine | null {
  for (const path of SETTINGS_CANDIDATES) {
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as ClaudeStatusLine;
      if (raw.rate_limits) return raw;
    } catch {
      // try next
    }
  }
  return null;
}

registerCollector(claudeCollector);
