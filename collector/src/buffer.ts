import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import type { UsageReading } from "./types.js";
import { configDir } from "./paths.js";

/**
 * Local buffer for readings that could not be reported (network error, 5xx,
 * 429). The next `run` replays buffered batches oldest-first before reporting
 * fresh ones (design §7.4: "失败时本地缓冲，下次带上未成功的批次").
 *
 * The design sets no numeric limits; these defaults keep a broken deployment
 * from growing the file without bound: 7 days retention (a week of hourly
 * runs is ample for transient outages), at most 50 batches / 1000 readings
 * (a normal hourly batch is single-digit readings). Oldest batches are
 * evicted first. Buffered readings keep their original capturedAt, so the
 * server-side CAS (capturedAt ordering) prevents a replayed stale value from
 * overwriting a newer one.
 */
export const BUFFER_LIMITS = {
  maxBatches: 50,
  maxReadings: 1000,
  retentionMs: 7 * 24 * 60 * 60 * 1000,
} as const;

export interface BufferedBatch {
  id: string;
  enqueuedAt: string;
  /** Last report error, truncated; never contains tokens (ReportError messages are status-only). */
  lastError: string;
  readings: UsageReading[];
}

function bufferFile(): string {
  return resolve(configDir(), "pending-reports.json");
}

function readBatches(): BufferedBatch[] {
  if (!existsSync(bufferFile())) return [];
  try {
    const raw = JSON.parse(readFileSync(bufferFile(), "utf8")) as { batches?: BufferedBatch[] };
    return Array.isArray(raw.batches) ? raw.batches : [];
  } catch {
    return [];
  }
}

function writeBatches(batches: BufferedBatch[]): void {
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(bufferFile(), JSON.stringify({ batches }, null, 2), { mode: 0o600 });
}

/** Drop expired batches, then evict oldest until within caps. */
function prune(batches: BufferedBatch[], now = Date.now()): BufferedBatch[] {
  let kept = batches.filter(
    (b) => now - Date.parse(b.enqueuedAt) < BUFFER_LIMITS.retentionMs,
  );
  while (kept.length > BUFFER_LIMITS.maxBatches) kept = kept.slice(1);
  while (kept.reduce((sum, b) => sum + b.readings.length, 0) > BUFFER_LIMITS.maxReadings) {
    kept = kept.slice(1);
  }
  return kept;
}

export function enqueueFailedBatch(readings: UsageReading[], error: string): BufferedBatch {
  const batch: BufferedBatch = {
    id: randomUUID(),
    enqueuedAt: new Date().toISOString(),
    lastError: error.slice(0, 200),
    readings,
  };
  writeBatches(prune([...readBatches(), batch]));
  return batch;
}

export function pendingBatches(): BufferedBatch[] {
  return prune(readBatches());
}

export function removeBatch(id: string): void {
  writeBatches(readBatches().filter((b) => b.id !== id));
}

export function clearBuffer(): void {
  writeBatches([]);
}

export interface BufferStats {
  batches: number;
  readings: number;
  oldestEnqueuedAt: string | null;
  lastError: string | null;
}

export function bufferStats(): BufferStats {
  const batches = pendingBatches();
  return {
    batches: batches.length,
    readings: batches.reduce((sum, b) => sum + b.readings.length, 0),
    oldestEnqueuedAt: batches[0]?.enqueuedAt ?? null,
    lastError: batches[batches.length - 1]?.lastError ?? null,
  };
}
