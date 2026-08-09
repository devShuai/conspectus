import { describe, expect, it } from "vitest";

import {
  IMPORT_DRAFT_PAYLOAD_VERSION,
  parseImportDraftPayload,
} from "./draft-payload";

/**
 * #57：草稿 payload 的版本化 Zod schema。底线是 strict —— 任何未声明字段
 * （HTML、脚本、template 残片）都不得进入 ImportDraft.payload。
 */
describe("importDraftPayload schema (#57)", () => {
  const valid = {
    version: IMPORT_DRAFT_PAYLOAD_VERSION,
    candidate: {
      vendorSlug: "netflix",
      name: "Netflix Standard",
      amount: "68.00",
      currency: "CNY",
      billedAt: "2026-08-01",
      billingCycle: "monthly",
      reference: "INV-123",
    },
    evidence: {
      sourceMessageId: "<m1@example.com>",
      fromAddr: "billing@example.com",
      subject: "Your receipt",
      matchedRule: "netflix/receipt/v1",
    },
  };

  it("accepts a well-formed v1 payload", () => {
    const parsed = parseImportDraftPayload(valid);
    expect(parsed.candidate.amount).toBe("68.00");
    expect(parsed.evidence?.matchedRule).toBe("netflix/receipt/v1");
  });

  it("accepts a minimal payload without optional fields", () => {
    const parsed = parseImportDraftPayload({
      version: 1,
      candidate: { name: "Claude Max", amount: "200", currency: "USD", billedAt: "2026-08-09" },
    });
    expect(parsed.evidence).toBeUndefined();
  });

  it("rejects payloads carrying undeclared fields (HTML/script smuggling)", () => {
    expect(() =>
      parseImportDraftPayload({ ...valid, html: "<script>alert(1)</script>" }),
    ).toThrow();
    expect(() =>
      parseImportDraftPayload({
        ...valid,
        candidate: { ...valid.candidate, htmlBody: "<img src=x onerror=alert(1)>" },
      }),
    ).toThrow();
    expect(() =>
      parseImportDraftPayload({
        ...valid,
        evidence: { ...valid.evidence, template: "<div>{{raw}}</div>" },
      }),
    ).toThrow();
  });

  it("rejects unknown versions and missing version", () => {
    expect(() => parseImportDraftPayload({ ...valid, version: 2 })).toThrow();
    const { version: _omit, ...noVersion } = valid;
    expect(() => parseImportDraftPayload(noVersion)).toThrow();
  });

  it("rejects non-decimal amounts and bad currency/date shapes", () => {
    expect(() =>
      parseImportDraftPayload({ ...valid, candidate: { ...valid.candidate, amount: "68.001" } }),
    ).toThrow();
    expect(() =>
      parseImportDraftPayload({ ...valid, candidate: { ...valid.candidate, amount: "abc" } }),
    ).toThrow();
    expect(() =>
      parseImportDraftPayload({ ...valid, candidate: { ...valid.candidate, currency: "cny" } }),
    ).toThrow();
    expect(() =>
      parseImportDraftPayload({ ...valid, candidate: { ...valid.candidate, billedAt: "2026/08/01" } }),
    ).toThrow();
  });
});
