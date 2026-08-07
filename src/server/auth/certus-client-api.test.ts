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
  it("requires opaque 404s and consented field set", () => {
    const consented: UserStatusEvidence = {
      httpStatus: 200,
      status: "active",
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
    const result = evaluateUserStatusContract({
      consented,
      missingUser: missing,
      invalidId: missing,
      badSecret: { httpStatus: 401 },
    });
    expect(result.go).toBe(true);
  });
});
