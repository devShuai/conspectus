import type { OIDCClaims } from "./claims.js";
import { fingerprint } from "./device-introspection.js";
import { tokenDigest } from "./opaque-store.js";

export interface RedactedClaimEvidence {
  capturedAt: number;
  subjectFingerprint: string;
  /** Present only in process memory for M0 status probing; never returned to browsers. */
  certusSub?: string;
  hasEmailClaim: boolean;
  emailVerified:
    | { kind: "boolean"; value: boolean }
    | { kind: "missing" }
    | { kind: "non_boolean"; typeofValue: string };
  hasEmailVerifiedClaim: boolean;
}

export interface PublicClaimEvidence {
  capturedAt: number;
  subjectFingerprint: string;
  hasEmailClaim: boolean;
  hasEmailVerifiedClaim: boolean;
  emailVerifiedKind: "boolean" | "missing" | "non_boolean";
  emailVerifiedValue?: boolean;
  emailVerifiedTypeof?: string;
}

const evidenceBySessionHash = new Map<string, RedactedClaimEvidence>();

export function summarizeIdTokenClaims(claims: OIDCClaims): RedactedClaimEvidence {
  const sub = typeof claims.sub === "string" ? claims.sub : "";
  const emailVerifiedRaw = claims.email_verified;
  let emailVerified: RedactedClaimEvidence["emailVerified"];
  if (emailVerifiedRaw === undefined) {
    emailVerified = { kind: "missing" };
  } else if (typeof emailVerifiedRaw === "boolean") {
    emailVerified = { kind: "boolean", value: emailVerifiedRaw };
  } else {
    emailVerified = { kind: "non_boolean", typeofValue: typeof emailVerifiedRaw };
  }

  return {
    capturedAt: Date.now(),
    subjectFingerprint: sub ? fingerprint(sub) : "missing-sub",
    certusSub: sub || undefined,
    hasEmailClaim: typeof claims.email === "string" && claims.email.length > 0,
    hasEmailVerifiedClaim: emailVerifiedRaw !== undefined,
    emailVerified,
  };
}

export function storeClaimEvidenceForSession(
  sessionToken: string,
  evidence: RedactedClaimEvidence,
): void {
  evidenceBySessionHash.set(tokenDigest(sessionToken), {
    ...evidence,
    // keep certusSub only in memory for same-process M0 status probes
    certusSub: evidence.certusSub,
  });
}

export function getPublicClaimEvidenceForSession(
  sessionToken: string,
): PublicClaimEvidence | null {
  const evidence = evidenceBySessionHash.get(tokenDigest(sessionToken));
  if (!evidence) {
    return null;
  }
  return toPublic(evidence);
}

/** Internal M0 helper: certus user id for status endpoint; never expose via HTTP. */
export function getCertusSubForSession(sessionToken: string): string | null {
  return evidenceBySessionHash.get(tokenDigest(sessionToken))?.certusSub ?? null;
}

export function resetClaimEvidenceForTests(): void {
  evidenceBySessionHash.clear();
}

export function discoveryEmailVerifiedSupported(
  claimsSupported: unknown,
): boolean {
  return (
    Array.isArray(claimsSupported) &&
    claimsSupported.every((item) => typeof item === "string") &&
    claimsSupported.includes("email_verified")
  );
}

export function evaluateClaimContract(input: {
  discoveryHasEmailVerified: boolean;
  idToken: PublicClaimEvidence | null;
}): { go: boolean; checks: Array<{ id: string; ok: boolean; detail: string }> } {
  const checks = [
    {
      id: "discovery_email_verified",
      ok: input.discoveryHasEmailVerified,
      detail: input.discoveryHasEmailVerified
        ? "claims_supported includes email_verified"
        : "claims_supported missing email_verified",
    },
    {
      id: "id_token_captured",
      ok: input.idToken !== null,
      detail: input.idToken
        ? `sub_fp=${input.idToken.subjectFingerprint}`
        : "no in-memory claim evidence; complete a browser login first",
    },
  ];

  if (input.idToken) {
    checks.push({
      id: "id_token_email_verified_boolean",
      ok: input.idToken.emailVerifiedKind === "boolean",
      detail: `kind=${input.idToken.emailVerifiedKind}${
        input.idToken.emailVerifiedKind === "boolean"
          ? ` value=${input.idToken.emailVerifiedValue}`
          : ""
      }`,
    });
    checks.push({
      id: "id_token_email_claim_with_scope",
      ok: true,
      detail: input.idToken.hasEmailClaim
        ? "email claim present (value not recorded)"
        : "email claim absent (user may lack email or scope)",
    });
  }

  return {
    go: checks.filter((c) => c.id !== "id_token_email_claim_with_scope").every((c) => c.ok),
    checks,
  };
}

function toPublic(evidence: RedactedClaimEvidence): PublicClaimEvidence {
  if (evidence.emailVerified.kind === "boolean") {
    return {
      capturedAt: evidence.capturedAt,
      subjectFingerprint: evidence.subjectFingerprint,
      hasEmailClaim: evidence.hasEmailClaim,
      hasEmailVerifiedClaim: evidence.hasEmailVerifiedClaim,
      emailVerifiedKind: "boolean",
      emailVerifiedValue: evidence.emailVerified.value,
    };
  }
  if (evidence.emailVerified.kind === "missing") {
    return {
      capturedAt: evidence.capturedAt,
      subjectFingerprint: evidence.subjectFingerprint,
      hasEmailClaim: evidence.hasEmailClaim,
      hasEmailVerifiedClaim: evidence.hasEmailVerifiedClaim,
      emailVerifiedKind: "missing",
    };
  }
  return {
    capturedAt: evidence.capturedAt,
    subjectFingerprint: evidence.subjectFingerprint,
    hasEmailClaim: evidence.hasEmailClaim,
    hasEmailVerifiedClaim: evidence.hasEmailVerifiedClaim,
    emailVerifiedKind: "non_boolean",
    emailVerifiedTypeof: evidence.emailVerified.typeofValue,
  };
}

