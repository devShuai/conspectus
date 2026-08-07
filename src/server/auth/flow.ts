import { timingSafeEqual } from "node:crypto";

import { localUserIdFromClaims } from "./claims";
import { loadAuthConfig, type AuthConfig } from "./config";
import { certusOIDCProvider, type OIDCProvider } from "./provider";
import { createAppSession } from "./session";
import {
  consumeOIDCTransaction,
  createOIDCTransaction,
} from "./transaction";

export type OIDCFlowErrorCode =
  | "invalid_callback_url"
  | "invalid_state"
  | "invalid_transaction"
  | "invalid_claims"
  | "authorization_response_rejected";

export class OIDCFlowError extends Error {
  constructor(
    public readonly code: OIDCFlowErrorCode,
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = "OIDCFlowError";
  }
}

export async function startOIDCLogin(
  options: {
    config?: AuthConfig;
    provider?: OIDCProvider;
    now?: number;
  } = {},
): Promise<{ authorizationUrl: URL; transactionHandle: string; expiresAt: number }> {
  const config = options.config ?? loadAuthConfig();
  const provider = options.provider ?? certusOIDCProvider;
  const security = await provider.createRequestSecurity();
  const authorizationUrl = await provider.buildAuthorizationURL(config, security);
  const { handle, transaction } = createOIDCTransaction(
    {
      state: security.state,
      nonce: security.nonce,
      codeVerifier: security.codeVerifier,
    },
    options.now,
  );
  return {
    authorizationUrl,
    transactionHandle: handle,
    expiresAt: transaction.expiresAt,
  };
}

export function canonicalOIDCCallbackURL(
  config: AuthConfig,
  searchParams: URLSearchParams,
): URL {
  const callbackUrl = new URL(config.callbackUrl);
  callbackUrl.search = searchParams.toString();
  return callbackUrl;
}

export async function completeOIDCLogin(
  currentUrl: URL,
  transactionHandle: string | undefined,
  options: {
    config?: AuthConfig;
    provider?: OIDCProvider;
    now?: number;
  } = {},
): Promise<{ sessionToken: string; userId: string; sessionExpiresAt: number }> {
  const config = options.config ?? loadAuthConfig();
  const provider = options.provider ?? certusOIDCProvider;
  const transaction = consumeOIDCTransaction(transactionHandle, options.now);
  if (!transaction) {
    throw new OIDCFlowError("invalid_transaction");
  }
  if (
    currentUrl.origin !== config.callbackUrl.origin ||
    currentUrl.pathname !== config.callbackUrl.pathname ||
    currentUrl.hash
  ) {
    throw new OIDCFlowError("invalid_callback_url");
  }
  const states = currentUrl.searchParams.getAll("state");
  if (states.length !== 1 || !equalOpaqueValue(states[0], transaction.state)) {
    throw new OIDCFlowError("invalid_state");
  }

  let claims;
  try {
    claims = await provider.exchangeAuthorizationCode(config, currentUrl, transaction);
  } catch (cause) {
    throw new OIDCFlowError("authorization_response_rejected", { cause });
  }

  let userId: string;
  try {
    userId = localUserIdFromClaims(claims, config, transaction.nonce);
  } catch (cause) {
    throw new OIDCFlowError("invalid_claims", { cause });
  }
  const { token, session } = createAppSession(userId, options.now);
  return {
    sessionToken: token,
    userId,
    sessionExpiresAt: session.expiresAt,
  };
}

function equalOpaqueValue(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}
