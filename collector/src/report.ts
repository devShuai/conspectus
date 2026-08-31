import type { CliConfig } from "./config.js";
import { validAccessToken } from "./auth.js";
import { ensureDevice, resetLocalDevice, signRequest } from "./device.js";
import { AGENT_VERSION } from "./version.js";
import type { LedgerDayRow } from "./collectors/codeburn-export.js";
import type { UsageReading } from "./types.js";
import { pendingBatches, removeBatch } from "./buffer.js";

export interface ReportResult {
  accepted: number;
  rejected: Array<{ index: number; reason: string }>;
}

const REPORT_PATH = "/api/collect/usage";
const LEDGER_PATH = "/api/collect/ledger";

function errorCode(text: string): string | undefined {
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    return typeof parsed.error === "string" ? parsed.error : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Send a device-signed JSON request. A genuinely missing server-side device
 * record is recoverable (for example after a database restore), so replace the
 * local key and retry exactly once. `device_revoked` is deliberately excluded:
 * automatic replacement would defeat single-device revocation.
 */
async function postSignedJson(
  config: CliConfig,
  accessToken: string,
  path: string,
  payload: (deviceId: string) => unknown,
): Promise<{ response: Response; errorText?: string }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const device = await ensureDevice(config);
    const bodyText = JSON.stringify(payload(device.deviceId));
    const signed = signRequest(device, { method: "POST", path, bodyText });
    const response = await fetch(`${config.serverUrl}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        ...signed,
      },
      body: bodyText,
    });
    if (response.ok) return { response };

    const errorText = await response.text().catch(() => "");
    if (
      attempt === 0 &&
      response.status === 403 &&
      errorCode(errorText) === "device_not_found"
    ) {
      await resetLocalDevice();
      continue;
    }
    return { response, errorText };
  }
  throw new Error("signed request retry exhausted");
}

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
  let sent: { response: Response; errorText?: string };
  try {
    sent = await postSignedJson(config, tokens.accessToken, REPORT_PATH, (deviceId) => ({
      deviceId,
      // 每次上报都带版本：注册那一次的值会随升级过期，而设备列表用它判断采集器是否
      // 太旧。签名覆盖整个 body，多带一个字段不影响校验。
      agentVersion: AGENT_VERSION,
      readings,
    }));
  } catch (cause) {
    throw new ReportError(
      `report failed: ${cause instanceof Error ? cause.message : String(cause)}`.slice(0, 200),
      true,
    );
  }
  const { response, errorText = "" } = sent;
  if (!response.ok) {
    if (errorCode(errorText) === "device_revoked") {
      throw new ReportError(
        "设备已被撤销；如需重新连接，请运行 'conspectus-collect login --replace-device' 并完成授权",
        false,
        response.status,
      );
    }
    if (errorText.includes("timestamp_out_of_window")) {
      throw new ReportError(
        "上报被拒：本机时间与服务器相差超过 5 分钟，请校准系统时间后重试",
        false,
        response.status,
      );
    }
    const retryable = response.status === 429 || response.status >= 500;
    throw new ReportError(
      `report failed: ${response.status} ${errorText.slice(0, 200)}`,
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


/**
 * 上报消耗流水账（#143）。与读数走**独立端点**：两者是不同的计量，共用契约会把
 * §4 要求分开建模的模型搅在一起。签名覆盖 path，所以两个端点的签名不可互换重放。
 *
 * 失败不进本地缓冲区：流水账每轮上报的是「该日至今的累计值」，下一轮自然带上这轮
 * 的量，补发没有意义 —— 而读数是时点值，漏了就永远缺一格，所以那边才需要缓冲。
 */
export async function reportLedger(
  config: CliConfig,
  days: LedgerDayRow[],
): Promise<{ accepted: number; rejected: Array<{ index: number; reason: string }> }> {
  if (days.length === 0) return { accepted: 0, rejected: [] };
  const tokens = await validAccessToken(config);
  const { response, errorText = "" } = await postSignedJson(
    config,
    tokens.accessToken,
    LEDGER_PATH,
    (deviceId) => ({ deviceId, agentVersion: AGENT_VERSION, days }),
  );
  if (!response.ok) {
    if (errorCode(errorText) === "device_revoked") {
      throw new ReportError(
        "设备已被撤销；如需重新连接，请运行 'conspectus-collect login --replace-device' 并完成授权",
        false,
        response.status,
      );
    }
    throw new ReportError(
      `ledger ${response.status} ${errorText.slice(0, 120)}`,
      response.status >= 500,
      response.status,
    );
  }
  return (await response.json()) as { accepted: number; rejected: Array<{ index: number; reason: string }> };
}
