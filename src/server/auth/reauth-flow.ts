import { timingSafeEqual } from "node:crypto";

import { db } from "@/server/db";

import { certusSubjectFromClaims } from "./claims";
import { loadAuthConfig, type AuthConfig } from "./config";
import { certusOIDCProvider, type OIDCProvider } from "./provider";
import {
  createReauthTransaction,
  findReauthTransaction,
  terminateReauthTransaction,
  verifyReauthTransaction,
} from "./reauth";
import {
  consumeOIDCTransaction,
  createOIDCTransaction,
} from "./transaction";

export type ReauthFlowErrorCode =
  | "invalid_context"
  | "invalid_transaction"
  | "invalid_callback_url"
  | "invalid_state"
  | "invalid_claims"
  | "authorization_response_rejected"
  | "identity_mismatch"
  | "stale_auth_time"
  | "verify_failed";

export class ReauthFlowError extends Error {
  constructor(
    public readonly code: ReauthFlowErrorCode,
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = "ReauthFlowError";
  }
}

/** 允许发起 reauth 的敏感动作（设计 §7.1）。 */
export const REAUTH_ACTIONS = ["export"] as const;
export type ReauthAction = (typeof REAUTH_ACTIONS)[number];

export interface ReauthFlowStart {
  authorizationUrl: URL;
  oidcHandle: string;
  oidcExpiresAt: number;
  reauthContext: string;
  reauthExpiresAt: number;
}

/**
 * 敏感操作重新认证（design §7.1）：certus 侧 `prompt=login&max_age=0` 重新授权，
 * 回调校验 auth_time 与 sub 后 CAS verifiedAt；目标 Action 再 CAS consumedAt。
 * sessionId 暂以 userId 代替 —— 与 /api/export 的 M1 简化一致（会话行 id 未暴露给 RSC）。
 */
export async function startReauthFlow(input: {
  userId: string;
  action: ReauthAction;
  targetPath: string;
  config?: AuthConfig;
  provider?: OIDCProvider;
  now?: number;
}): Promise<ReauthFlowStart> {
  const config = input.config ?? loadAuthConfig();
  const provider = input.provider ?? certusOIDCProvider;

  const reauth = await createReauthTransaction({
    userId: input.userId,
    sessionId: input.userId, // M1 简化，见上文
    action: input.action,
    now: input.now !== undefined ? new Date(input.now) : undefined,
  });

  const security = await provider.createRequestSecurity();
  const authorizationUrl = await provider.buildAuthorizationURL(config, security, {
    prompt: "login",
    max_age: "0",
  });
  const { handle, transaction } = createOIDCTransaction(
    {
      state: security.state,
      nonce: security.nonce,
      codeVerifier: security.codeVerifier,
    },
    input.now,
  );

  const reauthContext = Buffer.from(
    JSON.stringify({ token: reauth.token, target: input.targetPath }),
    "utf8",
  ).toString("base64url");

  return {
    authorizationUrl,
    oidcHandle: handle,
    oidcExpiresAt: transaction.expiresAt,
    reauthContext,
    reauthExpiresAt: reauth.expiresAt.getTime(),
  };
}

export interface ReauthFlowCompletion {
  action: string;
  targetPath: string;
  token: string;
}

export async function completeReauthFlow(input: {
  currentUrl: URL;
  oidcHandle: string | undefined;
  reauthContext: string | undefined;
  config?: AuthConfig;
  provider?: OIDCProvider;
  now?: number;
}): Promise<ReauthFlowCompletion> {
  const config = input.config ?? loadAuthConfig();
  const provider = input.provider ?? certusOIDCProvider;
  const now = input.now ?? Date.now();

  let context: { token: string; target: string };
  try {
    const parsed = JSON.parse(
      Buffer.from(input.reauthContext ?? "", "base64url").toString("utf8"),
    );
    if (typeof parsed.token !== "string" || typeof parsed.target !== "string") {
      throw new Error("bad shape");
    }
    context = parsed;
  } catch {
    throw new ReauthFlowError("invalid_context");
  }

  const reauthTx = await findReauthTransaction(context.token);
  if (
    !reauthTx ||
    reauthTx.consumedAt ||
    reauthTx.verifiedAt ||
    reauthTx.expiresAt.getTime() <= now
  ) {
    throw new ReauthFlowError("invalid_transaction");
  }

  const transaction = consumeOIDCTransaction(input.oidcHandle, now);
  if (!transaction) {
    throw new ReauthFlowError("invalid_transaction");
  }
  if (
    input.currentUrl.origin !== config.callbackUrl.origin ||
    input.currentUrl.pathname !== config.callbackUrl.pathname ||
    input.currentUrl.hash
  ) {
    throw new ReauthFlowError("invalid_callback_url");
  }
  const states = input.currentUrl.searchParams.getAll("state");
  if (
    states.length !== 1 ||
    !equalOpaqueValue(states[0], transaction.state)
  ) {
    throw new ReauthFlowError("invalid_state");
  }

  const fail = async (code: ReauthFlowErrorCode, options?: ErrorOptions): Promise<never> => {
    await terminateReauthTransaction(context.token);
    throw new ReauthFlowError(code, options);
  };

  let claims;
  try {
    const tokens = await provider.exchangeAuthorizationCode(
      config,
      input.currentUrl,
      transaction,
    );
    claims = tokens.claims;
  } catch (cause) {
    return fail("authorization_response_rejected", { cause });
  }

  let derivedSub: string;
  try {
    derivedSub = certusSubjectFromClaims(claims, config, transaction.nonce);
  } catch (cause) {
    return fail("invalid_claims", { cause });
  }

  // 回调的 sub 必须仍是发起事务的那个用户（design §7.1：禁止换号完成敏感操作）
  const user = await db.user.findFirst({
    where: { id: reauthTx.userId, certusSub: derivedSub },
    select: { id: true },
  });
  if (!user) {
    return fail("identity_mismatch");
  }

  // auth_time 为秒精度，与 createdAt 同精度（秒）比较，避免同秒内的毫秒截断误判
  const authTime = claims.auth_time;
  if (
    typeof authTime !== "number" ||
    Math.floor(authTime) < Math.floor(reauthTx.createdAt.getTime() / 1000)
  ) {
    return fail("stale_auth_time");
  }

  const verified = await verifyReauthTransaction({
    token: context.token,
    sessionId: reauthTx.sessionId,
    userId: reauthTx.userId,
    action: reauthTx.action,
    now: new Date(now),
  });
  if (!verified) {
    return fail("verify_failed");
  }

  return { action: reauthTx.action, targetPath: context.target, token: context.token };
}

function equalOpaqueValue(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return (
    leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
  );
}
