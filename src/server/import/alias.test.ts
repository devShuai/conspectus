import { describe, expect, it } from "vitest";

import {
  base32NoPad,
  generateInboundAlias,
  inboundAddressDisplay,
} from "./alias";
import {
  extractAliasLocalPart,
  signInboundRequest,
  verifyInboundSignature,
} from "./inbound";

/**
 * #58 别名与签名纯函数：128 bit 熵的 u-<26 位 base32> 形态、地址解析与
 * HMAC 签名校验。
 */
describe("inbound alias generation (#58)", () => {
  it("encodes RFC 4648 base32 lowercase without padding", () => {
    // RFC 4648 test vectors (lowercased, padding stripped)
    expect(base32NoPad(Buffer.from("f"))).toBe("my");
    expect(base32NoPad(Buffer.from("fo"))).toBe("mzxq");
    expect(base32NoPad(Buffer.from("foo"))).toBe("mzxw6");
    expect(base32NoPad(Buffer.from("foob"))).toBe("mzxw6yq");
    expect(base32NoPad(Buffer.from("fooba"))).toBe("mzxw6ytb");
    expect(base32NoPad(Buffer.from("foobar"))).toBe("mzxw6ytboi");
  });

  it("generates u-<26 base32> aliases from 128 bits of entropy", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i += 1) {
      const alias = generateInboundAlias();
      expect(alias).toMatch(/^u-[a-z2-7]{26}$/);
      seen.add(alias);
    }
    expect(seen.size).toBe(1000);
  });

  it("honours an injected entropy source (deterministic)", () => {
    const alias = generateInboundAlias(() => Buffer.alloc(16, 0));
    expect(alias).toBe(`u-${"a".repeat(26)}`);
  });

  it("renders the full address only when the domain is configured", () => {
    expect(inboundAddressDisplay("u-abc", { INBOUND_EMAIL_DOMAIN: "in.example.com" })).toBe(
      "u-abc@in.example.com",
    );
    expect(inboundAddressDisplay("u-abc", {})).toBeNull();
    expect(inboundAddressDisplay(null, { INBOUND_EMAIL_DOMAIN: "in.example.com" })).toBeNull();
  });
});

describe("extractAliasLocalPart (#58)", () => {
  it("accepts a well-formed alias address, case-insensitively", () => {
    const alias = generateInboundAlias();
    expect(extractAliasLocalPart(`${alias}@in.example.com`)).toBe(alias);
    expect(extractAliasLocalPart(`${alias.toUpperCase()}@IN.EXAMPLE.COM`)).toBe(alias);
  });

  it("rejects malformed addresses as unknown aliases", () => {
    expect(extractAliasLocalPart("plain@in.example.com")).toBeNull();
    expect(extractAliasLocalPart("u-tooshort@in.example.com")).toBeNull();
    expect(extractAliasLocalPart("u-ABCDEFGHIJKLMNOPQRSTUVW1@in.example.com")).toBeNull();
    expect(extractAliasLocalPart("")).toBeNull();
    expect(extractAliasLocalPart("no-at-sign")).toBeNull();
  });
});

describe("inbound signature (#58)", () => {
  const secret = "test-inbound-secret";

  it("round-trips and rejects tampering", () => {
    const ts = String(Date.now());
    const body = JSON.stringify({ messageId: "<m@e>" });
    const sig = signInboundRequest(secret, ts, body);
    expect(verifyInboundSignature(secret, ts, body, sig)).toBe(true);
    expect(verifyInboundSignature(secret, ts, body + " ", sig)).toBe(false);
    expect(verifyInboundSignature(secret, String(Number(ts) + 1), body, sig)).toBe(false);
    expect(verifyInboundSignature("other-secret", ts, body, sig)).toBe(false);
    expect(verifyInboundSignature(secret, ts, body, sig.slice(2))).toBe(false);
  });
});
