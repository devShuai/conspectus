import type { StoredToken } from "./types.js";
export interface CliConfig {
    serverUrl: string;
    issuer: string;
    cliClientId: string;
}
export declare function loadCliConfig(): CliConfig;
export declare function saveCliConfig(config: CliConfig): void;
/** Store tokens in the user config dir (keychain integration is a follow-up). */
export declare function storeTokens(tokens: StoredToken): void;
export declare function loadTokens(): StoredToken | null;
export declare function clearTokens(): void;
