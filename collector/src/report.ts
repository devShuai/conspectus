import type { CliConfig } from "./config.js";
import { validAccessToken } from "./auth.js";
import { ensureDevice, signRequest } from "./device.js";
import type { UsageReading } from "./types.js";

export interface ReportResult {
  accepted: number;
  rejected: Array<{ index: number; reason: string }>;
}

const REPORT_PATH = "/api/collect/usage";

/**
 * Report readings to conspectus /api/collect/usage. Buffered on failure;
 * caller retries the batch later (no data loss on transient errors).
 *
 * Every report is signed with this machine's device key: the server rejects
 * unsigned reports, which is what keeps a stolen CLI token from writing usage
 * and what makes single-device revocation effective.
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

  const response = await fetch(`${config.serverUrl}${REPORT_PATH}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${tokens.accessToken}`,
      "content-type": "application/json",
      ...signed,
    },
    body: bodyText,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    if (text.includes("timestamp_out_of_window")) {
      throw new Error(
        "上报被拒：本机时间与服务器相差超过 5 分钟，请校准系统时间后重试",
      );
    }
    throw new Error(`report failed: ${response.status} ${text.slice(0, 200)}`);
  }
  return (await response.json()) as ReportResult;
}

/** Fetch the manifest of bindings this collector may write. */
export async function fetchManifest(config: CliConfig): Promise<UsageReading["bindingId"][]> {
  const tokens = await validAccessToken(config);
  const response = await fetch(`${config.serverUrl}/api/collect/manifest`, {
    headers: { authorization: `Bearer ${tokens.accessToken}` },
  });
  if (!response.ok) throw new Error(`manifest failed: ${response.status}`);
  const body = (await response.json()) as { bindings: Array<{ bindingId: string }> };
  return body.bindings.map((b) => b.bindingId);
}
