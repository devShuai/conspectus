import { createRemoteJWKSet, jwtVerify, errors as joseErrors } from "jose";

import type { AuthConfig } from "./config";

export const BACKCHANNEL_LOGOUT_EVENT =
  "http://schemas.openid.net/event/backchannel-logout";
/** certus signs logout tokens with typ=logout+jwt (see SendTyped). */
const LOGOUT_TOKEN_TYP = "logout+jwt";
/** Minimum clock-skew grace applied when storing jti. */
export const LOGOUT_REPLAY_GRACE_MS = 10 * 60 * 1000;

export interface LogoutTokenClaims {
  iss: string;
  aud: string | string[];
  iat: number;
  exp?: number;
  jti: string;
  sid?: string;
  sub?: string;
  nonce?: unknown;
  events: Record<string, unknown>;
}

export class LogoutTokenError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = "LogoutTokenError";
  }
}

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function jwksFor(config: AuthConfig): ReturnType<typeof createRemoteJWKSet> {
  const jwksUri = config.issuer.href.replace(/\/$/, "") + "/oauth2/jwks";
  let set = jwksCache.get(jwksUri);
  if (!set) {
    set = createRemoteJWKSet(new URL(jwksUri));
    jwksCache.set(jwksUri, set);
  }
  return set;
}

/** Validate a raw logout_token JWT per OIDC Back-Channel Logout requirements. */
export async function validateLogoutToken(
  rawToken: string,
  config: AuthConfig,
  options: { now?: Date } = {},
): Promise<LogoutTokenClaims> {
  const now = options.now ?? new Date();

  let header: { typ?: string };
  try {
    const [encodedHeader] = rawToken.split(".");
    header = JSON.parse(
      Buffer.from(encodedHeader ?? "", "base64url").toString("utf8"),
    ) as { typ?: string };
  } catch {
    throw new LogoutTokenError("malformed_jwt");
  }
  if (header.typ !== LOGOUT_TOKEN_TYP) {
    throw new LogoutTokenError(`unexpected_typ:${header.typ ?? "none"}`);
  }

  let payload: Record<string, unknown>;
  try {
    const result = await jwtVerify(rawToken, jwksFor(config), {
      issuer: config.issuerIdentifier,
      audience: config.clientId,
      algorithms: ["RS256"],
    });
    payload = result.payload as Record<string, unknown>;
  } catch (cause) {
    const name =
      cause instanceof joseErrors.JOSEError ? cause.code ?? cause.name : "unknown";
    throw new LogoutTokenError(`signature_or_claims_invalid:${name}`);
  }

  const jti = stringClaim(payload.jti);
  if (!jti) throw new LogoutTokenError("missing_jti");
  const iat = numberClaim(payload.iat);
  if (iat === null) throw new LogoutTokenError("missing_iat");
  const sid = stringClaim(payload.sid);
  const sub = stringClaim(payload.sub);
  if (!sid && !sub) throw new LogoutTokenError("missing_sid_and_sub");
  // Per spec: logout tokens must NOT contain a nonce (that is an ID Token replay).
  if (payload.nonce !== undefined) throw new LogoutTokenError("unexpected_nonce");
  const events = payload.events;
  if (
    typeof events !== "object" ||
    events === null ||
    !(BACKCHANNEL_LOGOUT_EVENT in events)
  ) {
    throw new LogoutTokenError("missing_backchannel_event");
  }

  const exp = numberClaim(payload.exp);
  if (exp !== null && exp * 1000 <= now.getTime()) {
    throw new LogoutTokenError("token_expired");
  }

  return {
    iss: stringClaim(payload.iss) ?? "",
    aud: payload.aud as string | string[],
    iat,
    exp: exp ?? undefined,
    jti,
    sid: sid ?? undefined,
    sub: sub ?? undefined,
    nonce: payload.nonce,
    events: events as Record<string, unknown>,
  };
}

export function logoutReplayExpiry(
  tokenExp: number | undefined,
  now: Date,
): Date {
  const base =
    tokenExp !== undefined ? tokenExp * 1000 : now.getTime() + 2 * 60 * 1000;
  return new Date(base + LOGOUT_REPLAY_GRACE_MS);
}

export function resetLogoutTokenJwksForTests(): void {
  jwksCache.clear();
}

function stringClaim(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberClaim(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
