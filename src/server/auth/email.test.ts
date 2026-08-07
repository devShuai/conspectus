import { describe, expect, it } from "vitest";

import { normalizeEmail } from "./email";

describe("normalizeEmail", () => {
  it("trims, lowercases and IDNA-normalizes", () => {
    expect(normalizeEmail("  Alice@Example.COM ")).toBe("alice@example.com");
    expect(normalizeEmail("user@BÜCHER.example")).toBe("user@xn--bcher-kva.example");
  });

  it("rejects malformed addresses", () => {
    for (const bad of ["", "no-at-sign", "a@", "@b.com", "a b@c.com", "a@localhost"]) {
      expect(() => normalizeEmail(bad)).toThrow();
    }
  });
});
