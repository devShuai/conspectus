import type { CliConfig } from "./config.js";
import type { DeviceLoginResult, StoredToken } from "./types.js";
/**
 * certus Device Authorization Grant (RFC 8628) with usage:write only —
 * never requests web-session privileges. Polls interval/slow_down.
 */
export declare function deviceLogin(config: CliConfig, onCode: (result: DeviceLoginResult) => void): Promise<StoredToken>;
export declare function refreshAccessToken(config: CliConfig, tokens: StoredToken): Promise<StoredToken>;
export declare function validAccessToken(config: CliConfig): Promise<StoredToken>;
export declare function logout(): void;
