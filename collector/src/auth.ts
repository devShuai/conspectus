import * as oidc from "openid-client";

import type { CliConfig } from "./config.js";
import { storeTokens, loadTokens, clearTokens } from "./config.js";
import type { DeviceLoginResult, StoredToken } from "./types.js";

const SCOPES = "openid usage:write";

/**
 * certus Device Authorization Grant (RFC 8628) with usage:write only —
 * never requests web-session privileges. Polls interval/slow_down.
 */
export async function deviceLogin(
  config: CliConfig,
  onCode: (result: DeviceLoginResult) => void,
): Promise<StoredToken> {
  const provider = await providerConfig(config);
  const response = await oidc.initiateDeviceAuthorization(provider, {
    scope: SCOPES,
  });
  onCode({
    userCode: String(response.user_code),
    verificationUri: String(response.verification_uri),
    verificationUriComplete:
      typeof response.verification_uri_complete === "string"
        ? response.verification_uri_complete
        : undefined,
  });

  const tokens = await oidc.pollDeviceAuthorizationGrant(
    provider,
    response,
    undefined,
    { signal: AbortSignal.timeout((Number(response.expires_in) ?? 600) * 1000) },
  );
  if (typeof tokens.access_token !== "string") {
    throw new Error("device grant did not return access token");
  }
  const stored: StoredToken = {
    accessToken: tokens.access_token,
    refreshToken: typeof tokens.refresh_token === "string" ? tokens.refresh_token : "",
    expiresAt: Date.now() + (Number(tokens.expires_in) ?? 3600) * 1000,
  };
  storeTokens(stored);
  return stored;
}

export async function refreshAccessToken(
  config: CliConfig,
  tokens: StoredToken,
): Promise<StoredToken> {
  if (!tokens.refreshToken) throw new Error("no refresh token stored");
  const provider = await providerConfig(config);
  const refreshed = await oidc.refreshTokenGrant(provider, tokens.refreshToken, {
    scope: SCOPES,
  });
  const updated: StoredToken = {
    ...tokens,
    accessToken:
      typeof refreshed.access_token === "string" ? refreshed.access_token : tokens.accessToken,
    refreshToken:
      typeof refreshed.refresh_token === "string"
        ? refreshed.refresh_token
        : tokens.refreshToken,
    expiresAt: Date.now() + (Number(refreshed.expires_in) ?? 3600) * 1000,
  };
  storeTokens(updated);
  return updated;
}

export async function validAccessToken(config: CliConfig): Promise<StoredToken> {
  let tokens = loadTokens();
  if (!tokens?.accessToken) throw new Error("not logged in; run 'login'");
  if (Date.now() >= tokens.expiresAt - 30_000) {
    tokens = await refreshAccessToken(config, tokens);
  }
  return tokens;
}

export function logout(): void {
  clearTokens();
}

async function providerConfig(config: CliConfig): Promise<oidc.Configuration> {
  const options: oidc.DiscoveryRequestOptions = { timeout: 10 };
  const issuer = new URL(config.issuer);
  if (issuer.protocol === "http:") {
    options.execute = [oidc.allowInsecureRequests];
  }
  return oidc.discovery(
    issuer,
    config.cliClientId,
    { token_endpoint_auth_method: "none" },
    oidc.None(),
    options,
  );
}
