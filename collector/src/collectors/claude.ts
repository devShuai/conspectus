import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { runCli } from "../exec.js";
import { readExternalCredential } from "../keychain.js";
import type { LocalCollector, UsageReading } from "../types.js";
import { registerCollector } from "./registry.js";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const OAUTH_BETA = "oauth-2025-04-20";
const KEYCHAIN_SERVICES = ["Claude Code-credentials", "Claude Code", "Claude-credentials", "Claude"];

interface ClaudeUsageWindow {
  utilization?: unknown;
  resets_at?: unknown;
}

interface ClaudeUsagePayload {
  five_hour?: ClaudeUsageWindow;
  seven_day?: ClaudeUsageWindow;
}

interface ClaudeAuthStatus {
  loggedIn: boolean;
  authMethod?: string;
}

/** Claude.ai plan limits are shared by Claude Desktop and Claude Code. */
export const claudeCollector: LocalCollector = {
  id: "claude-code",
  displayName: "Claude Desktop / Claude Code",

  async detect(): Promise<boolean> {
    if (
      process.env.CLAUDE_CODE_OAUTH_TOKEN ||
      process.env.CLAUDE_ACCESS_TOKEN ||
      claudeCredentialFiles().some(existsSync) ||
      desktopInstallRoots().some(existsSync)
    ) {
      return true;
    }
    try {
      await runCli("claude", ["--version"]);
      return true;
    } catch {
      return false;
    }
  },

  async collect(ctx): Promise<UsageReading[]> {
    const token = await resolveClaudeAccessToken();
    const version = await resolveClaudeVersion();
    const response = await fetch(USAGE_URL, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        "content-type": "application/json",
        "anthropic-beta": OAUTH_BETA,
        "user-agent": `claude-code/${version}`,
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        "auth_expired: Claude OAuth credential was rejected; refresh CLAUDE_CODE_OAUTH_TOKEN",
      );
    }
    if (!response.ok) throw new Error(`claude usage HTTP ${response.status}`);
    return parseClaudeUsage(await response.json(), ctx.bindings, new Date().toISOString());
  },
};

export function parseClaudeUsage(
  body: unknown,
  bindings: Array<{ bindingId: string; metric: string; kind: string; unit: string }>,
  capturedAt: string,
): UsageReading[] {
  if (!isRecord(body)) throw new Error("unavailable: Claude usage schema drift");
  const payload = body as ClaudeUsagePayload;
  const output: UsageReading[] = [];
  appendWindow(output, bindings, "claude:five_hour", payload.five_hour, capturedAt);
  appendWindow(output, bindings, "claude:seven_day", payload.seven_day, capturedAt);
  if (output.length === 0) {
    throw new Error("unavailable: Claude plan has no five_hour or seven_day quota");
  }
  return output;
}

export function extractClaudeAccessToken(value: unknown): string | null {
  if (typeof value === "string") return isOAuthToken(value) ? value : null;
  if (!isRecord(value)) return null;
  for (const candidate of credentialCandidates(value)) {
    if (!isRecord(candidate)) continue;
    for (const key of ["accessToken", "access", "oauthToken", "token"]) {
      const token = candidate[key];
      if (typeof token === "string" && isOAuthToken(token)) return token;
    }
  }
  const accounts = value.accounts;
  if (Array.isArray(accounts)) {
    for (const account of accounts) {
      if (isRecord(account) && account.enabled !== false) {
        const token = extractClaudeAccessToken(account);
        if (token) return token;
      }
    }
  }
  return null;
}

export function parseClaudeAuthStatus(value: string): ClaudeAuthStatus | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || typeof parsed.loggedIn !== "boolean") return null;
  return {
    loggedIn: parsed.loggedIn,
    ...(typeof parsed.authMethod === "string" ? { authMethod: parsed.authMethod } : {}),
  };
}

export function claudeCredentialUnavailableError(status: ClaudeAuthStatus | null): Error {
  if (status?.loggedIn) {
    return new Error(
      "unsupported_auth_storage: Claude is signed in, but this installation does not expose its secure OAuth credential to external collectors; run `claude setup-token` and set CLAUDE_CODE_OAUTH_TOKEN",
    );
  }
  return new Error(
    "auth_required: Claude OAuth credential unavailable; run `claude auth login` or set CLAUDE_CODE_OAUTH_TOKEN",
  );
}

async function resolveClaudeAccessToken(): Promise<string> {
  for (const token of [process.env.CLAUDE_CODE_OAUTH_TOKEN, process.env.CLAUDE_ACCESS_TOKEN]) {
    if (token && isOAuthToken(token.trim())) return token.trim();
  }
  for (const path of claudeCredentialFiles()) {
    try {
      const token = extractClaudeAccessToken(JSON.parse(readFileSync(path, "utf8")));
      if (token) return token;
    } catch {
      // Try the next official/community-compatible read-only location.
    }
  }
  for (const service of KEYCHAIN_SERVICES) {
    const secret = await readExternalCredential(service).catch(() => null);
    if (!secret) continue;
    let value: unknown = secret;
    try {
      value = JSON.parse(secret);
    } catch {
      // A keychain entry can be the raw OAuth token.
    }
    const token = extractClaudeAccessToken(value);
    if (token) return token;
  }
  let status: ClaudeAuthStatus | null = null;
  try {
    status = parseClaudeAuthStatus(await runCli("claude", ["auth", "status"]));
  } catch {
    // A missing CLI or signed-out installation is handled as auth_required.
  }
  throw claudeCredentialUnavailableError(status);
}

async function resolveClaudeVersion(): Promise<string> {
  try {
    const output = await runCli("claude", ["--version"]);
    return output.match(/\d+\.\d+\.\d+/)?.[0] ?? "2.0.0";
  } catch {
    return "2.0.0";
  }
}

function claudeCredentialFiles(): string[] {
  const configRoot = process.env.CLAUDE_CONFIG_DIR ?? resolve(homedir(), ".claude");
  const files = [
    resolve(configRoot, ".credentials.json"),
    resolve(homedir(), ".config", "claude-code", "auth.json"),
    resolve(homedir(), ".config", "opencode", "opencode-anthropic-auth", "accounts.json"),
    resolve(homedir(), ".local", "share", "opencode", "auth.json"),
  ];
  if (process.env.APPDATA) {
    files.push(
      resolve(process.env.APPDATA, "Claude", ".credentials.json"),
      resolve(process.env.APPDATA, "Claude", "claude-code", ".credentials.json"),
    );
  }
  return [...new Set(files)];
}

function desktopInstallRoots(): string[] {
  return process.env.APPDATA ? [resolve(process.env.APPDATA, "Claude")] : [];
}

function credentialCandidates(value: Record<string, unknown>): unknown[] {
  return [
    value,
    value.oauth,
    value.claudeAiOauth,
    value.claudeAiOAuth,
    value.claudeOAuth,
    value.anthropic,
  ];
}

function appendWindow(
  output: UsageReading[],
  bindings: Array<{ bindingId: string; metric: string; kind: string; unit: string }>,
  metric: string,
  window: ClaudeUsageWindow | undefined,
  capturedAt: string,
): void {
  const binding = bindings.find((candidate) => candidate.metric === metric && candidate.kind === "quota");
  const utilization = Number(window?.utilization);
  if (!binding || !Number.isFinite(utilization) || utilization < 0 || utilization > 100) return;
  output.push({
    bindingId: binding.bindingId,
    kind: "quota",
    metric,
    unit: binding.unit,
    usedValue: String(utilization),
    limitValue: "100",
    periodEnd: typeof window?.resets_at === "string" ? window.resets_at : undefined,
    capturedAt,
  });
}

function isOAuthToken(value: string): boolean {
  return value.startsWith("sk-ant-oat") && value.length >= 16;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

registerCollector(claudeCollector);
