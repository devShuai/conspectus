import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

const DEFAULT_OAUTH_HOST = "https://auth.kimi.com";
const KIMI_CODE_CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
const MIN_REFRESH_THRESHOLD_SECONDS = 300;
const LOCK_STALE_MS = 120_000;
const LOCK_WAIT_MS = 15_000;
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

interface KimiCredentialWire extends Record<string, unknown> {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_at?: unknown;
  expires_in?: unknown;
  scope?: unknown;
  token_type?: unknown;
}

interface KimiCredential {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  expiresIn: number;
  scope: string;
  tokenType: string;
  wire: KimiCredentialWire;
}

interface KimiRefreshOptions {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  oauthHost?: string;
  maxRetries?: number;
  lockWaitMs?: number;
}

class KimiRefreshUnauthorizedError extends Error {}

export function readKimiAccessToken(path: string, nowMs: number): string {
  const credential = readKimiCredential(path);
  if (!isFresh(credential, nowMs)) {
    throw new Error("auth_expired: Kimi Code OAuth token needs refresh");
  }
  return credential.accessToken;
}

/**
 * Match Kimi Code's managed OAuth lifecycle without starting a second login.
 * The refresh token is never returned to callers or included in an error.
 */
export async function ensureKimiAccessToken(
  path: string,
  nowMs: number,
  options: KimiRefreshOptions = {},
): Promise<string> {
  const initial = readKimiCredential(path);
  if (isFresh(initial, nowMs)) return initial.accessToken;
  if (!initial.refreshToken) {
    throw new Error("auth_expired: Kimi Code credential has no refresh token; run `kimi login`");
  }

  const sleep = options.sleep ?? defaultSleep;
  const release = await acquireRefreshLock(path, sleep, options.lockWaitMs ?? LOCK_WAIT_MS);
  try {
    // Another collector process may have refreshed while this process waited.
    const active = readKimiCredential(path);
    if (isFresh(active, nowMs)) return active.accessToken;
    if (!active.refreshToken) {
      throw new Error("auth_expired: Kimi Code credential has no refresh token; run `kimi login`");
    }

    try {
      const refreshed = await refreshKimiCredential(active, nowMs, options);
      writeKimiCredential(path, refreshed);
      return refreshed.accessToken;
    } catch (error) {
      if (error instanceof KimiRefreshUnauthorizedError) {
        // Kimi Code may have rotated the one-time refresh token concurrently.
        // Give its atomic write a moment to land, then prefer the newer file.
        await sleep(100);
        const recovered = tryReadKimiCredential(path);
        if (
          recovered &&
          recovered.refreshToken !== active.refreshToken &&
          isFresh(recovered, Date.now())
        ) {
          return recovered.accessToken;
        }
        throw new Error("auth_expired: Kimi Code OAuth refresh was rejected; run `kimi login`");
      }
      throw error;
    }
  } finally {
    release();
  }
}

function readKimiCredential(path: string): KimiCredential {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("auth_required: Kimi Code credentials not found; run `kimi login`");
  }
  if (!isRecord(parsed)) {
    throw new Error("auth_required: Kimi Code credential file is invalid; run `kimi login`");
  }
  const accessToken = stringValue(parsed.access_token);
  if (!accessToken) {
    throw new Error("auth_required: Kimi Code access token missing; run `kimi login`");
  }
  return {
    accessToken,
    refreshToken: stringValue(parsed.refresh_token),
    expiresAt: finiteNumber(parsed.expires_at),
    expiresIn: finiteNumber(parsed.expires_in),
    scope: stringValue(parsed.scope),
    tokenType: stringValue(parsed.token_type) || "Bearer",
    wire: parsed,
  };
}

function tryReadKimiCredential(path: string): KimiCredential | null {
  try {
    return readKimiCredential(path);
  } catch {
    return null;
  }
}

function isFresh(credential: KimiCredential, nowMs: number): boolean {
  if (!Number.isFinite(credential.expiresAt) || credential.expiresAt <= 0) return false;
  const threshold = Math.max(
    MIN_REFRESH_THRESHOLD_SECONDS,
    credential.expiresIn > 0 ? credential.expiresIn * 0.5 : 0,
  );
  return credential.expiresAt > Math.floor(nowMs / 1000) + threshold;
}

async function refreshKimiCredential(
  active: KimiCredential,
  nowMs: number,
  options: KimiRefreshOptions,
): Promise<KimiCredential> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const maxRetries = options.maxRetries ?? 3;
  const oauthHost = (
    options.oauthHost ??
    process.env.KIMI_CODE_OAUTH_HOST ??
    process.env.KIMI_OAUTH_HOST ??
    DEFAULT_OAUTH_HOST
  ).replace(/\/+$/, "");
  const body = new URLSearchParams({
    client_id: KIMI_CODE_CLIENT_ID,
    grant_type: "refresh_token",
    refresh_token: active.refreshToken,
  }).toString();

  let lastFailure: unknown;
  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    let response: Response;
    try {
      response = await fetchImpl(`${oauthHost}/api/oauth/token`, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
        },
        body,
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      lastFailure = error;
      if (attempt < maxRetries - 1) {
        await sleep(2 ** attempt * 1_000);
        continue;
      }
      break;
    }

    const payload = await response.json().catch(() => null);
    if (response.ok && isRecord(payload)) {
      const accessToken = stringValue(payload.access_token);
      const refreshToken = stringValue(payload.refresh_token);
      const expiresIn = finiteNumber(payload.expires_in);
      if (!accessToken || !refreshToken || expiresIn <= 0) {
        throw new Error("unavailable: Kimi OAuth refresh response is incomplete");
      }
      return {
        accessToken,
        refreshToken,
        expiresAt: Math.floor(nowMs / 1000) + expiresIn,
        expiresIn,
        scope: stringValue(payload.scope),
        tokenType: stringValue(payload.token_type) || "Bearer",
        wire: {
          ...active.wire,
          access_token: accessToken,
          refresh_token: refreshToken,
          expires_at: Math.floor(nowMs / 1000) + expiresIn,
          expires_in: expiresIn,
          scope: stringValue(payload.scope),
          token_type: stringValue(payload.token_type) || "Bearer",
        },
      };
    }

    const errorCode = isRecord(payload) ? stringValue(payload.error) : "";
    if (response.status === 401 || response.status === 403 || errorCode === "invalid_grant") {
      throw new KimiRefreshUnauthorizedError("Kimi OAuth refresh unauthorized");
    }
    if (RETRYABLE_STATUSES.has(response.status) && attempt < maxRetries - 1) {
      await sleep(2 ** attempt * 1_000);
      continue;
    }
    throw new Error(`unavailable: Kimi OAuth refresh HTTP ${response.status}`);
  }
  throw new Error(
    `unavailable: Kimi OAuth refresh request failed${lastFailure ? " after retries" : ""}`,
  );
}

function writeKimiCredential(path: string, credential: KimiCredential): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp.${process.pid}.${randomBytes(4).toString("hex")}`;
  const data = Buffer.from(`${JSON.stringify(credential.wire, null, 2)}\n`, "utf8");
  const descriptor = openSync(temporary, "wx", 0o600);
  try {
    let offset = 0;
    while (offset < data.length) {
      offset += writeSync(descriptor, data, offset, data.length - offset);
    }
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  try {
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // Preserve the original write error.
    }
    throw error;
  }
}

async function acquireRefreshLock(
  credentialPath: string,
  sleep: (ms: number) => Promise<void>,
  waitMs: number,
): Promise<() => void> {
  const lockPath = `${credentialPath}.conspectus-refresh.lock`;
  const deadline = Date.now() + waitMs;
  while (true) {
    try {
      const descriptor = openSync(lockPath, "wx", 0o600);
      try {
        writeSync(descriptor, `${process.pid}\n${Date.now()}\n`);
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      return () => {
        try {
          unlinkSync(lockPath);
        } catch {
          // A stale-lock recovery may already have removed it.
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
          unlinkSync(lockPath);
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error("unavailable: Kimi OAuth refresh is busy in another collector process");
      }
      await sleep(100);
    }
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function finiteNumber(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
