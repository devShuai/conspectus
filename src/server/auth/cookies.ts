import type { AuthConfig } from "./config";

export const SESSION_COOKIE_NAME = "conspectus_session";
export const OIDC_TRANSACTION_COOKIE_NAME = "conspectus_oidc_tx";
export const REAUTH_COOKIE_NAME = "conspectus_reauth";

interface CookieOptions {
  httpOnly: boolean;
  secure: boolean;
  sameSite: "lax";
  path: string;
  expires: Date;
  priority: "high";
  maxAge?: number;
}

export function sessionCookieOptions(
  config: AuthConfig,
  expiresAt: number,
): CookieOptions {
  return {
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: "lax",
    path: "/",
    expires: new Date(expiresAt),
    priority: "high",
  };
}

export function transactionCookieOptions(
  config: AuthConfig,
  expiresAt: number,
): CookieOptions {
  return {
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: "lax",
    path: config.callbackUrl.pathname,
    expires: new Date(expiresAt),
    priority: "high",
  };
}

export function expiredSessionCookieOptions(config: AuthConfig): CookieOptions {
  return {
    ...sessionCookieOptions(config, 0),
    maxAge: 0,
  };
}

export function expiredTransactionCookieOptions(config: AuthConfig): CookieOptions {
  return {
    ...transactionCookieOptions(config, 0),
    maxAge: 0,
  };
}

/** reauth 上下文 Cookie 与 OIDC 事务 Cookie 一样只在回调路径上发送。 */
export function reauthCookieOptions(
  config: AuthConfig,
  expiresAt: number,
): CookieOptions {
  return {
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: "lax",
    path: config.callbackUrl.pathname,
    expires: new Date(expiresAt),
    priority: "high",
  };
}

export function expiredReauthCookieOptions(config: AuthConfig): CookieOptions {
  return {
    ...reauthCookieOptions(config, 0),
    maxAge: 0,
  };
}
