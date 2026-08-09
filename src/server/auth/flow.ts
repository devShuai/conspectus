import { timingSafeEqual } from "node:crypto";

import {
  certusSubjectFromClaims,
  legacyDerivedSubject,
  type OIDCClaims,
} from "./claims";
import { loadAuthConfig, type AuthConfig } from "./config";
import { AccountSuspendedError } from "./login-policy";
import { certusOIDCProvider, type OIDCProvider } from "./provider";
import {
  createOIDCTransaction,
  readOIDCTransaction,
} from "./transaction";

/** 运行时可枚举，错误页的文案表靠它做覆盖断言，避免两张表再次漂移（#123）。 */
export const OIDC_FLOW_ERROR_CODES = [
  "invalid_callback_url",
  "invalid_state",
  "invalid_transaction",
  "invalid_claims",
  "authorization_response_rejected",
  "account_suspended",
] as const;

export type OIDCFlowErrorCode = (typeof OIDC_FLOW_ERROR_CODES)[number];

export class OIDCFlowError extends Error {
  constructor(
    public readonly code: OIDCFlowErrorCode,
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = "OIDCFlowError";
  }
}

export interface OIDCTokenResult {
  claims: OIDCClaims;
  refreshToken?: string;
  idToken?: string;
}

/** Session creation side effect of a completed login; DB-backed in prod, in-memory in tests. */
export interface CertusIdentitySnapshot {
  /** certus's raw `sub` (design §6.2). */
  certusSub: string;
  /** Pre-#94 digest of the same subject; adopts a legacy row once. */
  legacySub?: string;
  sid?: string;
  email?: string;
  emailVerified?: boolean;
  idTokenIat?: number;
  name?: string;
}

export interface SessionWriter {
  create(input: {
    identity: CertusIdentitySnapshot;
    derivedUserId: string;
    refreshToken?: string | null;
    idToken?: string | null;
    now?: Date;
  }): Promise<{ sessionToken: string; userId: string; sessionExpiresAt: number }>;
  /** Returns the session row id too: reauth binds to the session, not just the user (#99). */
  find(
    token: string | undefined,
    now?: Date,
  ): Promise<{ userId: string; sessionId: string } | null>;
  delete(token: string | undefined): Promise<void>;
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
    config.authSecret,
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
    sessions?: SessionWriter;
    now?: number;
  } = {},
): Promise<{ sessionToken: string; userId: string; sessionExpiresAt: number }> {
  const config = options.config ?? loadAuthConfig();
  const provider = options.provider ?? certusOIDCProvider;
  const sessions = options.sessions ?? (await import("./db-flow")).dbSessionWriter;
  const transaction = readOIDCTransaction(
    transactionHandle,
    config.authSecret,
    options.now,
  );
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

  let tokens: OIDCTokenResult;
  try {
    tokens = await provider.exchangeAuthorizationCode(config, currentUrl, transaction);
  } catch (cause) {
    throw new OIDCFlowError("authorization_response_rejected", { cause });
  }

  let userId: string;
  try {
    userId = certusSubjectFromClaims(tokens.claims, config, transaction.nonce);
  } catch (cause) {
    throw new OIDCFlowError("invalid_claims", { cause });
  }

  const sid = typeof tokens.claims.sid === "string" ? tokens.claims.sid : undefined;
  const idTokenIat =
    typeof tokens.claims.iat === "number" ? tokens.claims.iat : undefined;
  const email = typeof tokens.claims.email === "string" ? tokens.claims.email : undefined;
  const emailVerified =
    typeof tokens.claims.email_verified === "boolean"
      ? tokens.claims.email_verified
      : undefined;
  const name = typeof tokens.claims.name === "string" ? tokens.claims.name : undefined;

  let session: Awaited<ReturnType<SessionWriter["create"]>>;
  try {
    session = await sessions.create({
      identity: {
        certusSub: userId,
        legacySub: legacyDerivedSubject(config.issuerIdentifier, userId),
        sid,
        email,
        emailVerified,
        idTokenIat,
        name,
      },
      derivedUserId: userId,
      refreshToken: tokens.refreshToken,
      idToken: tokens.idToken,
      now: options.now !== undefined ? new Date(options.now) : undefined,
    });
  } catch (cause) {
    if (cause instanceof AccountSuspendedError) {
      throw new OIDCFlowError("account_suspended", { cause });
    }
    throw cause;
  }

  return session;
}

function equalOpaqueValue(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}
