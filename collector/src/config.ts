import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";

import type { StoredToken } from "./types.js";
import { configDir } from "./paths.js";
import { secretStore } from "./keychain.js";

const TOKENS_ACCOUNT = "auth-tokens";

function tokenFile(): string {
  return resolve(configDir(), "tokens.json");
}

function configFile(): string {
  return resolve(configDir(), "config.json");
}

export interface CliConfig {
  serverUrl: string;
  issuer: string;
  cliClientId: string;
}

export function loadCliConfig(): CliConfig {
  if (!existsSync(configFile())) {
    throw new Error(
      `config not found at ${configFile()}; run 'conspectus-collect configure'`,
    );
  }
  const raw = JSON.parse(readFileSync(configFile(), "utf8")) as Record<string, unknown>;
  const config: CliConfig = {
    serverUrl: String(raw.serverUrl ?? ""),
    issuer: String(raw.issuer ?? ""),
    cliClientId: String(raw.cliClientId ?? "conspectus-cli"),
  };
  if (!config.serverUrl || !config.issuer) {
    throw new Error("config requires serverUrl and issuer");
  }
  return config;
}

export function saveCliConfig(config: CliConfig): void {
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(configFile(), JSON.stringify(config, null, 2), { mode: 0o600 });
}

/** Non-secret config file location, exposed for --diagnose. */
export function cliConfigPath(): string {
  return configFile();
}

/**
 * Tokens live in the OS keychain (design §7.4). A legacy plaintext
 * tokens.json (pre-keychain releases) is migrated on first read and deleted.
 */
export async function storeTokens(tokens: StoredToken): Promise<void> {
  const store = await secretStore();
  await store.set(TOKENS_ACCOUNT, JSON.stringify(tokens));
  if (existsSync(tokenFile())) unlinkSync(tokenFile());
}

export async function loadTokens(): Promise<StoredToken | null> {
  const store = await secretStore();
  const raw = await store.get(TOKENS_ACCOUNT);
  if (raw) {
    try {
      return JSON.parse(raw) as StoredToken;
    } catch {
      return null;
    }
  }
  if (!existsSync(tokenFile())) return null;
  try {
    const legacy = JSON.parse(readFileSync(tokenFile(), "utf8")) as StoredToken;
    if (!legacy.accessToken) return null;
    await store.set(TOKENS_ACCOUNT, JSON.stringify(legacy));
    unlinkSync(tokenFile());
    return legacy;
  } catch {
    return null;
  }
}

export async function clearTokens(): Promise<void> {
  const store = await secretStore();
  await store.delete(TOKENS_ACCOUNT);
  if (existsSync(tokenFile())) unlinkSync(tokenFile());
}
