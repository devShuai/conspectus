import { db } from "@/server/db";

import { bindCertusToUser, BindError } from "./bind";
import { certusSubjectFromClaims, legacyDerivedSubject } from "./claims";
import { loadAuthConfig, type AuthConfig } from "./config";
import { certusOIDCProvider, type OIDCProvider } from "./provider";
import { consumeOIDCTransaction, createOIDCTransaction } from "./transaction";

export type BindFlowErrorCode =
  | "invalid_transaction"
  | "invalid_state"
  | "invalid_claims"
  | "authorization_response_rejected"
  | "not_a_bind_transaction"
  | "session_mismatch";

export class BindFlowError extends Error {
  constructor(
    public readonly code: BindFlowErrorCode,
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = "BindFlowError";
  }
}

export interface BindFlowStart {
  authorizationUrl: URL;
  oidcHandle: string;
  oidcExpiresAt: number;
}

/**
 * Bind certus to the signed-in account (design §7.1 「合并只能由已登录用户主动发起」).
 *
 * The subject is only ever taken from an ID Token this flow obtained itself.
 * Accepting a `sub` from the client — as the previous POST did — let any
 * signed-in user claim a certus subject that had not logged in yet; when the
 * real owner later signed in, JIT attached them to the attacker's account
 * (#96).
 *
 * The intent (purpose + which user) lives in the server-side OIDC transaction
 * and is reached only through the opaque handle, so nothing about it can be
 * edited in the browser.
 */
export async function startBindFlow(input: {
  userId: string;
  config?: AuthConfig;
  provider?: OIDCProvider;
  now?: number;
}): Promise<BindFlowStart> {
  const config = input.config ?? loadAuthConfig();
  const provider = input.provider ?? certusOIDCProvider;

  const security = await provider.createRequestSecurity();
  // prompt=login: the user must prove control of the certus account *now*,
  // not merely have an existing SSO session in this browser.
  const authorizationUrl = await provider.buildAuthorizationURL(config, security, {
    prompt: "login",
    max_age: "0",
  });
  const { handle, transaction } = createOIDCTransaction(
    {
      state: security.state,
      nonce: security.nonce,
      codeVerifier: security.codeVerifier,
      purpose: "bind",
      bindUserId: input.userId,
    },
    input.now,
  );

  return {
    authorizationUrl,
    oidcHandle: handle,
    oidcExpiresAt: transaction.expiresAt,
  };
}

export interface BindFlowCompletion {
  userId: string;
  certusSub: string;
}

/**
 * Complete the bind callback. Throws BindError for the user-facing outcomes
 * (sub already used, already bound) and BindFlowError for protocol failures.
 */
export async function completeBindFlow(input: {
  currentUrl: URL;
  oidcHandle: string | undefined;
  sessionUserId: string;
  config?: AuthConfig;
  provider?: OIDCProvider;
  now?: number;
}): Promise<BindFlowCompletion> {
  const config = input.config ?? loadAuthConfig();
  const provider = input.provider ?? certusOIDCProvider;

  const transaction = consumeOIDCTransaction(input.oidcHandle, input.now);
  if (!transaction) throw new BindFlowError("invalid_transaction");
  if (transaction.purpose !== "bind" || !transaction.bindUserId) {
    // A login transaction must never be replayed into a bind.
    throw new BindFlowError("not_a_bind_transaction");
  }
  // The browser that finishes the flow must still be the session that started
  // it; otherwise a stolen handle could attach a subject to another account.
  if (transaction.bindUserId !== input.sessionUserId) {
    throw new BindFlowError("session_mismatch");
  }

  const returnedState = input.currentUrl.searchParams.get("state");
  if (!returnedState || returnedState !== transaction.state) {
    throw new BindFlowError("invalid_state");
  }

  let tokens;
  try {
    tokens = await provider.exchangeAuthorizationCode(config, input.currentUrl, transaction);
  } catch (cause) {
    throw new BindFlowError("authorization_response_rejected", { cause });
  }

  let sub: string;
  try {
    sub = certusSubjectFromClaims(tokens.claims, config, transaction.nonce);
  } catch (cause) {
    throw new BindFlowError("invalid_claims", { cause });
  }

  // A row created before #94 still carries the digest; adopt it here too so
  // binding cannot produce a duplicate account for the same subject.
  const legacy = await db.user.findUnique({
    where: { certusSubLegacy: legacyDerivedSubject(config.issuerIdentifier, sub) },
  });
  if (legacy && legacy.id !== transaction.bindUserId) {
    throw new BindError("sub_in_use", "certus sub belongs to another account");
  }

  await bindCertusToUser({
    userId: transaction.bindUserId,
    claims: {
      sub,
      name: tokens.claims.name,
      email: tokens.claims.email,
    },
    config,
  });

  return { userId: transaction.bindUserId, certusSub: sub };
}
