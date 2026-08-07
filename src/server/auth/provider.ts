import { createHash } from "node:crypto";

import * as oidc from "openid-client";

import type { OIDCClaims } from "./claims.js";
import type { AuthConfig } from "./config.js";
import type { OIDCTransaction } from "./transaction.js";
import type { OIDCTokenResult } from "./flow.js";

export interface RequestSecurity {
  state: string;
  nonce: string;
  codeVerifier: string;
  codeChallenge: string;
}

export interface OIDCProvider {
  createRequestSecurity(): Promise<RequestSecurity>;
  buildAuthorizationURL(
    config: AuthConfig,
    security: RequestSecurity,
  ): Promise<URL>;
  exchangeAuthorizationCode(
    config: AuthConfig,
    currentUrl: URL,
    transaction: OIDCTransaction,
  ): Promise<OIDCTokenResult>;
}

const configurationCache = new Map<string, Promise<oidc.Configuration>>();

export const certusOIDCProvider: OIDCProvider = {
  async createRequestSecurity() {
    const codeVerifier = oidc.randomPKCECodeVerifier();
    return {
      state: oidc.randomState(),
      nonce: oidc.randomNonce(),
      codeVerifier,
      codeChallenge: await oidc.calculatePKCECodeChallenge(codeVerifier),
    };
  },

  async buildAuthorizationURL(config, security) {
    const provider = await providerConfiguration(config);
    return oidc.buildAuthorizationUrl(provider, {
      redirect_uri: config.callbackUrl.href,
      scope: "openid profile email",
      state: security.state,
      nonce: security.nonce,
      code_challenge: security.codeChallenge,
      code_challenge_method: "S256",
    });
  },

  async exchangeAuthorizationCode(config, currentUrl, transaction) {
    const provider = await providerConfiguration(config);
    const tokens = await oidc.authorizationCodeGrant(provider, currentUrl, {
      pkceCodeVerifier: transaction.codeVerifier,
      expectedState: transaction.state,
      expectedNonce: transaction.nonce,
      idTokenExpected: true,
    });
    const claims = tokens.claims();
    if (!claims) {
      throw new Error("OIDC token response did not contain ID Token claims");
    }
    return {
      claims,
      refreshToken:
        typeof tokens.refresh_token === "string" ? tokens.refresh_token : undefined,
      idToken: typeof tokens.id_token === "string" ? tokens.id_token : undefined,
    };
  },
};

async function providerConfiguration(config: AuthConfig): Promise<oidc.Configuration> {
  // Secret rotation invalidates discovery without retaining raw secret fragments in the key.
  const secretFingerprint = createHash("sha256")
    .update(config.clientSecret, "utf8")
    .digest("base64url");
  const cacheKey = [
    config.issuerIdentifier,
    config.clientId,
    config.callbackUrl.href,
    secretFingerprint,
  ].join("\0");
  let pending = configurationCache.get(cacheKey);
  if (!pending) {
    const options: oidc.DiscoveryRequestOptions = { timeout: 10 };
    if (config.issuer.protocol === "http:") {
      options.execute = [oidc.allowInsecureRequests];
    }
    pending = oidc.discovery(
      config.issuer,
      config.clientId,
      {
        client_secret: config.clientSecret,
        redirect_uris: [config.callbackUrl.href],
        token_endpoint_auth_method: "client_secret_basic",
      },
      oidc.ClientSecretBasic(config.clientSecret),
      options,
    );
    configurationCache.set(cacheKey, pending);
    pending.catch(() => configurationCache.delete(cacheKey));
  }
  return pending;
}

export function resetOIDCProviderCacheForTests(): void {
  configurationCache.clear();
}
