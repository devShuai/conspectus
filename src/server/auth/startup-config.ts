import { currentAuthMode, type AuthMode } from "./auth-mode";
import { loadAuthConfig, type AuthConfig } from "./config";
import { loadCredentialKeyring } from "./crypto";

export interface StartupConfig {
  /** local 模式下为 null（不加载也不要求 CERTUS_* 变量） */
  auth: AuthConfig | null;
  authMode: AuthMode;
  cronSecret: string;
  deployProbeSecret: string;
  identityStatusTtlMs: number;
  identityStatusMaxStaleMs: number;
}

const DEFAULT_TTL_MS = 60 * 60 * 1000;
const DEFAULT_MAX_STALE_MS = 24 * 60 * 60 * 1000;

/**
 * Fail-fast startup gate (design.md §5.4 / §12.4):
 * - AUTH_MODE ∈ certus/local/both；非法值拒绝启动
 * - certus 与 both 要求完整 CERTUS_*；local 不要求（§10 M1b 交付标准）
 * - AUTH_SECRET 始终要求（local 会话与一次性令牌也用它）
 * - CRON_SECRET non-empty, not a default placeholder
 * - DEPLOY_PROBE_SECRET non-empty, distinct from CRON_SECRET
 * - active credential key present in keyring
 * - TTL/MAX_STALE relationship sane (TTL < MAX_STALE)
 */
export function loadStartupConfig(
  environment: Record<string, string | undefined> = process.env,
): StartupConfig {
  const authMode = currentAuthMode(environment);

  // 数据源闸门（issue #64）：TEST_DATABASE_URL 出现在生产环境本身就是部署事故，
  // 与 CRON_SECRET 非默认值同级，拒绝服务而不是静默切换数据源。
  if (
    environment.NODE_ENV === "production" &&
    environment.TEST_DATABASE_URL?.trim()
  ) {
    throw new Error(
      "TEST_DATABASE_URL must not be set in production; it would silently switch the datasource to the test database",
    );
  }

  // AUTH_SECRET 与认证方式无关（会话 Cookie、一次性令牌都要签）；certus 系变量只在
  // certus/both 下加载——local 模式不设 CERTUS_* 也必须能启动（§12.4）
  requireAuthSecret(environment);
  const auth = authMode === "local" ? null : loadAuthConfig(environment);
  loadCredentialKeyring(environment); // throws if active key missing

  const cronSecret = requiredNonDefault(
    "CRON_SECRET",
    environment.CRON_SECRET,
    ["change-me", "changeme", "secret", "cron-secret"],
  );
  const deployProbeSecret = requiredNonDefault(
    "DEPLOY_PROBE_SECRET",
    environment.DEPLOY_PROBE_SECRET,
    ["change-me", "changeme", "secret", "probe-secret"],
  );
  if (deployProbeSecret === cronSecret) {
    throw new Error("DEPLOY_PROBE_SECRET must differ from CRON_SECRET");
  }

  const identityStatusTtlMs = parseDurationMs(
    "IDENTITY_STATUS_TTL",
    environment.IDENTITY_STATUS_TTL,
    DEFAULT_TTL_MS,
  );
  const identityStatusMaxStaleMs = parseDurationMs(
    "IDENTITY_STATUS_MAX_STALE",
    environment.IDENTITY_STATUS_MAX_STALE,
    DEFAULT_MAX_STALE_MS,
  );
  if (identityStatusTtlMs >= identityStatusMaxStaleMs) {
    throw new Error("IDENTITY_STATUS_TTL must be less than IDENTITY_STATUS_MAX_STALE");
  }

  return {
    auth,
    authMode,
    cronSecret,
    deployProbeSecret,
    identityStatusTtlMs,
    identityStatusMaxStaleMs,
  };
}

function requireAuthSecret(environment: Record<string, string | undefined>): void {
  const secret = environment.AUTH_SECRET?.trim();
  if (!secret) throw new Error("AUTH_SECRET is required");
  if (Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error("AUTH_SECRET must be at least 32 bytes");
  }
}

function requiredNonDefault(
  name: string,
  value: string | undefined,
  placeholders: string[],
): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new Error(`${name} is required`);
  }
  if (placeholders.includes(normalized.toLowerCase())) {
    throw new Error(`${name} must not be a placeholder value`);
  }
  return normalized;
}

function parseDurationMs(
  name: string,
  raw: string | undefined,
  fallback: number,
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const match = /^(\d+)\s*(ms|s|m|h)?$/.exec(raw.trim());
  if (!match) throw new Error(`${name} must be like "1h", "30m", "900s" or "60000ms"`);
  const value = Number(match[1]);
  const unit = match[2] ?? "ms";
  const multiplier =
    unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : 3_600_000;
  return value * multiplier;
}

export function authConfigFromStartup(config: StartupConfig): AuthConfig | null {
  return config.auth;
}
