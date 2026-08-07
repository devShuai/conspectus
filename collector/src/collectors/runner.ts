import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

import type { LocalCollector, UsageReading } from "../types.js";
import { listCollectors } from "./registry.js";

export interface CollectorRunStatus {
  id: string;
  ok: boolean;
  error?: string;
  readings: number;
  lastSuccessAt?: string;
  lastErrorAt?: string;
}

const STATE_FILE = resolve(homedir(), ".conspectus", "collector-state.json");

/**
 * Run all collectors with independent failure isolation and persisted status.
 * One collector failing never blocks the others; unavailable collectors are
 * reported (never faked with stale numbers).
 */
export async function runAllCollectors(
  bindings: Array<{ bindingId: string; metric: string; kind: string; unit: string }>,
): Promise<{ readings: UsageReading[]; statuses: CollectorRunStatus[] }> {
  const statuses: CollectorRunStatus[] = [];
  const readings: UsageReading[] = [];
  const now = new Date().toISOString();

  for (const collector of listCollectors()) {
    try {
      if (!(await collector.detect())) {
        statuses.push({ id: collector.id, ok: false, error: "not_installed", readings: 0 });
        continue;
      }
      const collected = await collector.collect({ bindings });
      readings.push(...collected);
      const status: CollectorRunStatus = {
        id: collector.id,
        ok: true,
        readings: collected.length,
        lastSuccessAt: now,
      };
      statuses.push(status);
    } catch (cause) {
      const status: CollectorRunStatus = {
        id: collector.id,
        ok: false,
        error: cause instanceof Error ? cause.message.slice(0, 200) : "unknown",
        readings: 0,
        lastErrorAt: now,
      };
      statuses.push(status);
    }
  }

  persistState(statuses);
  return { readings, statuses };
}

export function persistState(statuses: CollectorRunStatus[]): void {
  const state = readState();
  for (const status of statuses) {
    if (status.ok) state[status.id] = { lastSuccessAt: status.lastSuccessAt ?? null, lastErrorAt: null };
    else state[status.id] = { lastSuccessAt: null, lastErrorAt: status.lastErrorAt ?? null };
  }
  mkdirSync(resolve(homedir(), ".conspectus"), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
}

export function readState(): Record<string, { lastSuccessAt: string | null; lastErrorAt: string | null }> {
  if (!existsSync(STATE_FILE)) return {};
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

/** Version gate helper: assert a minimum known-good version before probing. */
export function versionAtLeast(current: string, minimum: string): boolean {
  const a = current.split(".").map(Number);
  const b = minimum.split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av !== bv) return av > bv;
  }
  return true;
}

void ({} as LocalCollector);
