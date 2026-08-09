import { describe, expect, it } from "vitest";

import {
  evaluateCapabilities,
  evaluateUserStatusContract,
  type CapabilitiesEvidence,
  type UserStatusEvidence,
} from "./certus-client-api";

describe("evaluateCapabilities", () => {
  it("goes when schema and features match design", () => {
    const evidence: CapabilitiesEvidence = {
      httpStatus: 200,
      schemaVersion: 1,
      features: [
        "client_user_status",
        "cross_client_introspection",
        "email_verified",
      ],
      introspectionSources: ["conspectus-cli"],
      configRevision: "v1.abc",
      hasClientUserStatus: true,
      hasEmailVerifiedFeature: true,
      hasCrossClientIntrospection: true,
      includesCliSource: true,
      cacheControl: "no-store",
    };
    expect(evaluateCapabilities(evidence).go).toBe(true);
  });
});

describe("evaluateUserStatusContract", () => {
  const consented: UserStatusEvidence = {
    httpStatus: 200,
    status: "active",
    email: "alice@example.com",
    emailVerified: false,
    hasUpdatedAt: true,
    subjectFingerprint: "fp",
    notFoundOpaque: false,
    leakedProfileFields: [],
  };
  const missing: UserStatusEvidence = {
    httpStatus: 404,
    hasUpdatedAt: false,
    notFoundOpaque: true,
    leakedProfileFields: [],
  };

  it("requires opaque 404s and consented field set", () => {
    const result = evaluateUserStatusContract({
      consented,
      missingUser: missing,
      invalidId: missing,
      badSecret: { httpStatus: 401 },
    });
    expect(result.go).toBe(true);
  });

  // certus#10 / #125：验证位必须带着地址一起来，否则后台投递只能 fail-closed
  it("fails when email_verified arrives without the address it describes", () => {
    const result = evaluateUserStatusContract({
      consented: { ...consented, email: undefined },
      missingUser: missing,
      invalidId: missing,
      badSecret: { httpStatus: 401 },
    });
    expect(result.go).toBe(false);
    expect(
      result.checks.find((c) => c.id === "email_paired_with_verification")?.ok,
    ).toBe(false);
  });
});
