import { createHash } from "node:crypto";

import type { AuthConfig } from "./config";

export type OIDCClaims = Record<string, unknown>;

export class OIDCClaimsError extends Error {
  constructor(public readonly code: "invalid_claims") {
    super(code);
    this.name = "OIDCClaimsError";
  }
}

/**
 * Validate the ID Token claims and return certus's **raw** `sub`.
 *
 * design.md §6.2 defines `User.certusSub` as certus's `sub` itself. It was
 * previously stored as a derived digest, which silently broke two contracts:
 * Back-Channel Logout compares the raw sub from the logout_token, and the
 * status endpoint takes the raw sub as a path parameter. A digest cannot be
 * reversed, so those call sites had no way back to the real value.
 */
export function certusSubjectFromClaims(
  claims: OIDCClaims,
  config: AuthConfig,
  expectedNonce: string,
): string {
  const subject = stringClaim(claims.sub);
  const issuer = stringClaim(claims.iss);
  const nonce = stringClaim(claims.nonce);
  const audience = claims.aud;

  if (
    !subject ||
    issuer !== config.issuerIdentifier ||
    nonce !== expectedNonce ||
    !audienceContains(audience, config.clientId)
  ) {
    throw new OIDCClaimsError("invalid_claims");
  }

  return subject;
}

/**
 * The digest that used to be written to `certusSub`. Kept only so a row
 * created before #94 can be matched once and upgraded in place on the next
 * login; nothing new is ever stored with it.
 */
export function legacyDerivedSubject(issuer: string, subject: string): string {
  const digest = createHash("sha256")
    .update(issuer, "utf8")
    .update("\0", "utf8")
    .update(subject, "utf8")
    .digest("base64url");
  return `usr_${digest}`;
}

function stringClaim(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function audienceContains(value: unknown, clientId: string): boolean {
  return value === clientId ||
    (Array.isArray(value) && value.every((item) => typeof item === "string") && value.includes(clientId));
}
