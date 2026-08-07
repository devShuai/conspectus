import { describe, expect, it } from "vitest";

import {
  assertStrongPassword,
  hashPassword,
  PasswordPolicyError,
  verifyPassword,
} from "./password";

describe("password policy", () => {
  it("rejects short and weak passwords", () => {
    expect(() => assertStrongPassword("short")).toThrow(PasswordPolicyError);
    expect(() => assertStrongPassword("password123456")).toThrow(/too common/);
    expect(() => assertStrongPassword("correct-horse-battery-9!")).not.toThrow();
  });

  it("hashes with Argon2id and verifies", async () => {
    const hash = await hashPassword("correct-horse-battery-9!");
    expect(hash.startsWith("$argon2id$")).toBe(true);
    expect(await verifyPassword("correct-horse-battery-9!", hash)).toBe(true);
    expect(await verifyPassword("wrong", hash)).toBe(false);
  });
});
