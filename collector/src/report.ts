import type { CliConfig } from "./config.js";
import { validAccessToken } from "./auth.js";
import { ensureDevice, signRequest } from "./device.js";
import type { UsageReading } from "./types.js";
import { pendingBatches, removeBatch } from "./buffer.js";

export interface ReportResult {
  accepted: number;
  rejected: Array<{ index: number; reason: string }>;
}

const REPORT_PATH = "/api/collect/usage";

/**
 * Report failure. `retryable` marks transient conditions (network, 5xx, 429)
 * where the batch must be buffered locally and replayed next run; other
 * failures (4xx, clock skew) are definitive and would fail again on replay.
 */
export class ReportError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ReportError";
  }
}

export function isRetryableReportError(cause: unknown): boolean {
  return cause instanceof ReportError && cause.retryable;
}

/**
 * Report readings to conspectus /api/collect/usage.
 *
 * Every report is signed with this machine's device key: the server rejects
 * unsigned reports, which is what keeps a stolen CLI token from writing usage
 * and what makes single-device revocation effective.
 *
 * On failure this throws ReportError; the caller (cli run / flushReportBuffer)
 * buffers retryable batches locally — no data loss on transient errors.
 */
export async function reportReadings(
  config: CliConfig,
  readings: UsageReading[],
): Promise<ReportResult> {
  const tokens = await validAccessToken(config);
  const device = await ensureDevice(config);
  const bodyText = JSON.stringify({ deviceId: device.deviceId, readings });
  const signed = signRequest(device, {
    method: "POST",
    path: REPORT_PATH,
    bodyText,
  });

  let response: Response;
  try {
    response = await fetch(`${config.serverUrl}${REPORT_PATH}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${tokens.accessToken}`,
        "content-type": "application/json",
        ...signed,
      },
      body: bodyText,
    });
  } catch (cause) {
    throw new ReportError(
      `report failed: ${cause instanceof Error ? cause.message : String(cause)}`.slice(0, 200),
      true,
    );
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    if (text.includes("timestamp_out_of_window")) {
      throw new ReportError(
        "上报被拒：本机时间与服务器相差超过 5 分钟，请校准系统时间后重试",
        false,
        response.status,
      );
    }
    const retryable = response.status === 429 || response.status >= 500;
    throw new ReportError(
      `report failed: ${response.status} ${text.slice(0, 200)}`,
      retryable,
      response.status,
    );
  }
  return (await response.json()) as ReportResult;
}

export interface FlushResult {
  flushed: number;
  /** Batches the server definitively rejected (4xx) — replaying cannot help. */
  dropped: number;
  remaining: number;
  /** True when the flush stopped on a transient failure; skip this run's report too. */
  retryableFailure: boolean;
  error?: string;
}

/**
 * Replay buffered batches oldest-first (design §7.4). Stops at the first
 * transient failure to avoid hammering an unreachable server; a definitive
 * (4xx) rejection drops that batch and continues with the rest. Non-report
 * errors (token refresh, device registration) also stop the flush and keep
 * every batch.
 */
export async function flushReportBuffer(config: CliConfig): Promise<FlushResult> {
  let flushed = 0;
  let dropped = 0;
  let error: string | undefined;
  for (const batch of pendingBatches()) {
    try {
      await reportReadings(config, batch.readings);
      removeBatch(batch.id);
      flushed++;
    } catch (cause) {
      error = (cause instanceof Error ? cause.message : String(cause)).slice(0, 200);
      if (cause instanceof ReportError && !cause.retryable) {
        removeBatch(batch.id);
        dropped++;
        continue;
      }
      return {
        flushed,
        dropped,
        remaining: pendingBatches().length,
        retryableFailure: true,
        error,
      };
    }
  }
  return { flushed, dropped, remaining: pendingBatches().length, retryableFailure: false, error };
}

export interface ManifestBinding {
  bindingId: string;
  collectorId: string;
  subscriptionName?: string;
  metric: string;
  kind: "quota" | "balance" | "counter";
  unit: string;
}

/** Fetch the manifest of bindings this collector may write. */
export async function fetchManifest(config: CliConfig): Promise<ManifestBinding[]> {
  const tokens = await validAccessToken(config);
  const response = await fetch(`${config.serverUrl}/api/collect/manifest`, {
    headers: { authorization: `Bearer ${tokens.accessToken}` },
  });
  if (!response.ok) throw new Error(`manifest failed: ${response.status}`);
  const body = (await response.json()) as { bindings: ManifestBinding[] };
  return body.bindings;
}
