import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { cliConfigPath } from "./config.js";
import { configDir } from "./paths.js";
import { describeSecretStore, secretStore } from "./keychain.js";
import { bufferStats, type BufferStats } from "./buffer.js";
import { readState } from "./collectors/runner.js";

/**
 * `conspectus-collect diagnose` — local-only diagnostics (design §7.4: the
 * wire schema has no `raw`, so troubleshooting output may only ever be
 * printed on this machine and reviewed by the user).
 *
 * Redaction contract: token values and the device private key are NEVER
 * included — only presence booleans and expiry timestamps. Tests pin this.
 */
export interface DiagnoseReport {
  generatedAt: string;
  config: {
    path: string;
    exists: boolean;
    parseError?: string;
    serverUrl?: string;
    issuer?: string;
    cliClientId?: string;
  };
  keychain: { backend: string; osBackendActive: boolean };
  tokens: {
    present: boolean;
    hasAccessToken: boolean;
    hasRefreshToken: boolean;
    expiresAt?: string;
    expired?: boolean;
  };
  device: { registered: boolean; deviceId?: string; keyPresent: boolean };
  connectivity: {
    server?: { reachable: boolean; status?: number; error?: string };
    issuer?: { reachable: boolean; status?: number; error?: string };
  };
  buffer: BufferStats;
  collectors: Record<string, { lastSuccessAt: string | null; lastErrorAt: string | null }>;
}

async function probe(
  url: string,
): Promise<{ reachable: boolean; status?: number; error?: string }> {
  try {
    // Unauthenticated on purpose: any HTTP response (even 401) proves reachability.
    const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    return { reachable: true, status: response.status };
  } catch (cause) {
    return {
      reachable: false,
      error: (cause instanceof Error ? cause.message : String(cause)).slice(0, 200),
    };
  }
}

export async function runDiagnose(): Promise<DiagnoseReport> {
  const report: DiagnoseReport = {
    generatedAt: new Date().toISOString(),
    config: { path: cliConfigPath(), exists: false },
    keychain: { backend: "unknown", osBackendActive: false },
    tokens: { present: false, hasAccessToken: false, hasRefreshToken: false },
    device: { registered: false, keyPresent: false },
    connectivity: {},
    buffer: bufferStats(),
    collectors: readState(),
  };

  let serverUrl: string | undefined;
  let issuer: string | undefined;
  if (existsSync(report.config.path)) {
    report.config.exists = true;
    try {
      const raw = JSON.parse(readFileSync(report.config.path, "utf8")) as Record<string, unknown>;
      serverUrl = typeof raw.serverUrl === "string" ? raw.serverUrl : undefined;
      issuer = typeof raw.issuer === "string" ? raw.issuer : undefined;
      report.config.serverUrl = serverUrl;
      report.config.issuer = issuer;
      report.config.cliClientId = String(raw.cliClientId ?? "conspectus-cli");
    } catch (cause) {
      report.config.parseError = cause instanceof Error ? cause.message : String(cause);
    }
  }

  const backend = await describeSecretStore();
  report.keychain = { backend: backend.name, osBackendActive: backend.available };

  // Presence only — the values never leave the store.
  const store = await secretStore();
  const tokensRaw = await store.get("auth-tokens").catch(() => null);
  if (tokensRaw) {
    try {
      const tokens = JSON.parse(tokensRaw) as {
        accessToken?: string;
        refreshToken?: string;
        expiresAt?: number;
      };
      report.tokens = {
        present: true,
        hasAccessToken: Boolean(tokens.accessToken),
        hasRefreshToken: Boolean(tokens.refreshToken),
        ...(typeof tokens.expiresAt === "number"
          ? {
              expiresAt: new Date(tokens.expiresAt).toISOString(),
              expired: Date.now() >= tokens.expiresAt,
            }
          : {}),
      };
    } catch {
      report.tokens.present = true;
    }
  }

  const deviceKey = await store.get("device-key").catch(() => null);
  report.device.keyPresent = Boolean(deviceKey);
  const deviceFile = readDeviceId();
  if (deviceFile) {
    report.device.registered = true;
    report.device.deviceId = deviceFile;
  }

  if (serverUrl) {
    report.connectivity.server = await probe(`${serverUrl}/api/collect/manifest`);
  }
  if (issuer) {
    report.connectivity.issuer = await probe(
      `${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`,
    );
  }

  return report;
}

function readDeviceId(): string | null {
  try {
    const path = resolve(configDir(), "device.json");
    if (!existsSync(path)) return null;
    const raw = JSON.parse(readFileSync(path, "utf8")) as { deviceId?: string };
    return typeof raw.deviceId === "string" ? raw.deviceId : null;
  } catch {
    return null;
  }
}
