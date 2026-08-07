import { describe, expect, it } from "vitest";

import {
  discoveryEmailVerifiedSupported,
  evaluateClaimContract,
  getPublicClaimEvidenceForSession,
  resetClaimEvidenceForTests,
  storeClaimEvidenceForSession,
  summarizeIdTokenClaims,
} from "./claim-evidence.js";

describe("summarizeIdTokenClaims", () => {
  it("records boolean email_verified without exposing email", () => {
    const evidence = summarizeIdTokenClaims({
      sub: "user-1",
      email: "secret@example.com",
      email_verified: false,
    });
    expect(evidence.hasEmailClaim).toBe(true);
    expect(evidence.emailVerified).toEqual({ kind: "boolean", value: false });
    expect(JSON.stringify(evidence)).not.toContain("secret@example.com");
  });

  it("marks missing email_verified", () => {
    const evidence = summarizeIdTokenClaims({ sub: "user-1" });
    expect(evidence.emailVerified).toEqual({ kind: "missing" });
  });
});

describe("session-bound claim evidence", () => {
  it("returns public view without certusSub", () => {
    resetClaimEvidenceForTests();
    storeClaimEvidenceForSession(
      "session-token",
      summarizeIdTokenClaims({
        sub: "user-1",
        email: "a@b.c",
        email_verified: true,
      }),
    );
    const pub = getPublicClaimEvidenceForSession("session-token");
    expect(pub?.emailVerifiedValue).toBe(true);
    expect(JSON.stringify(pub)).not.toContain("user-1");
    expect(JSON.stringify(pub)).not.toContain("a@b.c");
  });
});

describe("evaluateClaimContract", () => {
  it("requires discovery claim and boolean id token field", () => {
    expect(discoveryEmailVerifiedSupported(["email", "email_verified"])).toBe(true);
    const result = evaluateClaimContract({
      discoveryHasEmailVerified: true,
      idToken: {
        capturedAt: 1,
        subjectFingerprint: "fp",
        hasEmailClaim: true,
        hasEmailVerifiedClaim: true,
        emailVerifiedKind: "boolean",
        emailVerifiedValue: false,
      },
    });
    expect(result.go).toBe(true);
  });
});
