import { createHmac, timingSafeEqual } from "node:crypto";

export const OIDC_TRANSACTION_TTL_MS = 10 * 60 * 1000;
const COOKIE_VERSION = "v1";
const MAX_COOKIE_LENGTH = 4_096;

export interface OIDCTransaction {
  state: string;
  nonce: string;
  codeVerifier: string;
  expiresAt: number;
  /** Signed flow intent; the browser can carry it but cannot change it. */
  purpose: "login" | "bind";
  /** For `bind`: the already-authenticated user the sub will be attached to. */
  bindUserId?: string;
}

type OIDCTransactionInput = Omit<OIDCTransaction, "expiresAt" | "purpose"> & {
  purpose?: OIDCTransaction["purpose"];
};

type SignedPayload = {
  s: string;
  n: string;
  c: string;
  e: number;
  p: OIDCTransaction["purpose"];
  u?: string;
};

function signature(value: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(value, "utf8").digest();
}

function nonEmptyBounded(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function decodeCanonicalBase64Url(value: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const decoded = Buffer.from(value, "base64url");
  return decoded.toString("base64url") === value ? decoded : null;
}

function payloadToTransaction(payload: unknown, now: number): OIDCTransaction | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  if (Object.keys(record).some((key) => !["s", "n", "c", "e", "p", "u"].includes(key))) {
    return null;
  }
  if (
    !nonEmptyBounded(record.s, 512) ||
    !nonEmptyBounded(record.n, 512) ||
    !nonEmptyBounded(record.c, 512) ||
    !Number.isSafeInteger(record.e) ||
    (record.p !== "login" && record.p !== "bind")
  ) {
    return null;
  }
  const expiresAt = record.e as number;
  if (expiresAt <= now) return null;
  if (record.p === "bind") {
    if (!nonEmptyBounded(record.u, 128)) return null;
  } else if (record.u !== undefined) {
    return null;
  }
  return {
    state: record.s,
    nonce: record.n,
    codeVerifier: record.c,
    expiresAt,
    purpose: record.p,
    ...(record.p === "bind" ? { bindUserId: record.u as string } : {}),
  };
}

export function createOIDCTransaction(
  input: OIDCTransactionInput,
  secret: string,
  now = Date.now(),
): { handle: string; transaction: OIDCTransaction } {
  const purpose = input.purpose ?? "login";
  if (
    (purpose !== "login" && purpose !== "bind") ||
    !nonEmptyBounded(input.state, 512) ||
    !nonEmptyBounded(input.nonce, 512) ||
    !nonEmptyBounded(input.codeVerifier, 512) ||
    (purpose === "bind" && !nonEmptyBounded(input.bindUserId, 128)) ||
    (purpose === "login" && input.bindUserId !== undefined)
  ) {
    throw new Error("invalid OIDC transaction");
  }
  const transaction: OIDCTransaction = {
    state: input.state,
    nonce: input.nonce,
    codeVerifier: input.codeVerifier,
    expiresAt: now + OIDC_TRANSACTION_TTL_MS,
    purpose,
    ...(purpose === "bind" ? { bindUserId: input.bindUserId } : {}),
  };
  const payload: SignedPayload = {
    s: transaction.state,
    n: transaction.nonce,
    c: transaction.codeVerifier,
    e: transaction.expiresAt,
    p: transaction.purpose,
    ...(transaction.bindUserId ? { u: transaction.bindUserId } : {}),
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const protectedValue = `${COOKIE_VERSION}.${encodedPayload}`;
  const handle = `${protectedValue}.${signature(protectedValue, secret).toString("base64url")}`;
  if (handle.length > MAX_COOKIE_LENGTH) throw new Error("OIDC transaction cookie is too large");
  return { handle, transaction };
}

/**
 * Verify and decode the stateless transaction. The callback route expires the
 * Cookie on every terminal path; Certus additionally enforces one-time use of
 * the authorization code across concurrent callback attempts.
 */
export function readOIDCTransaction(
  handle: string | undefined,
  secret: string,
  now = Date.now(),
): OIDCTransaction | null {
  return verifyOIDCTransaction(handle, secret, now);
}

/**
 * Verify without completing the flow, so the callback can dispatch on the
 * signed purpose. A plain client-supplied marker must never choose the branch.
 */
export function peekOIDCTransaction(
  handle: string | undefined,
  secret: string,
  now = Date.now(),
): OIDCTransaction | null {
  return readOIDCTransaction(handle, secret, now);
}

function verifyOIDCTransaction(
  handle: string | undefined,
  secret: string,
  now: number,
): OIDCTransaction | null {
  if (!handle || handle.length > MAX_COOKIE_LENGTH || !secret) return null;
  const parts = handle.split(".");
  if (parts.length !== 3 || parts[0] !== COOKIE_VERSION) return null;
  const encodedPayload = parts[1];
  const encodedSignature = parts[2];
  const payloadBytes = decodeCanonicalBase64Url(encodedPayload);
  const suppliedSignature = decodeCanonicalBase64Url(encodedSignature);
  if (!payloadBytes || !suppliedSignature || suppliedSignature.length !== 32) return null;
  const expectedSignature = signature(`${COOKIE_VERSION}.${encodedPayload}`, secret);
  if (!timingSafeEqual(suppliedSignature, expectedSignature)) return null;

  try {
    return payloadToTransaction(JSON.parse(payloadBytes.toString("utf8")), now);
  } catch {
    return null;
  }
}
