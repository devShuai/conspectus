import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { homedir } from "node:os";
const CONFIG_DIR = resolve(homedir(), ".conspectus");
const TOKEN_FILE = resolve(CONFIG_DIR, "tokens.json");
const CONFIG_FILE = resolve(CONFIG_DIR, "config.json");
export function loadCliConfig() {
    if (!existsSync(CONFIG_FILE)) {
        throw new Error(`config not found at ${CONFIG_FILE}; run 'conspectus-collect configure'`);
    }
    const raw = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
    const config = {
        serverUrl: String(raw.serverUrl ?? ""),
        issuer: String(raw.issuer ?? ""),
        cliClientId: String(raw.cliClientId ?? "conspectus-cli"),
    };
    if (!config.serverUrl || !config.issuer) {
        throw new Error("config requires serverUrl and issuer");
    }
    return config;
}
export function saveCliConfig(config) {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
}
/** Store tokens in the user config dir (keychain integration is a follow-up). */
export function storeTokens(tokens) {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2), { mode: 0o600 });
}
export function loadTokens() {
    if (!existsSync(TOKEN_FILE))
        return null;
    try {
        return JSON.parse(readFileSync(TOKEN_FILE, "utf8"));
    }
    catch {
        return null;
    }
}
export function clearTokens() {
    if (existsSync(TOKEN_FILE)) {
        writeFileSync(TOKEN_FILE, "{}", { mode: 0o600 });
    }
}
void dirname;
