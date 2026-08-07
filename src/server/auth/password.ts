import argon2 from "argon2";

export const PASSWORD_MIN_LENGTH = 12;

/** Common weak passwords checked before hashing (design §7.1). */
const WEAK_PASSWORDS = new Set([
  "password",
  "password123",
  "12345678",
  "qwerty123",
  "letmein",
  "welcome123",
  "admin123",
  "123456789",
  "1234567890",
  "iloveyou",
  "monkey123",
  "abc123456",
  "password123456",
  "password123456789",
]);

export class PasswordPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PasswordPolicyError";
  }
}

export function assertStrongPassword(password: string): void {
  if (password.length < PASSWORD_MIN_LENGTH) {
    throw new PasswordPolicyError(
      `password must be at least ${PASSWORD_MIN_LENGTH} characters`,
    );
  }
  if (WEAK_PASSWORDS.has(password.toLowerCase())) {
    throw new PasswordPolicyError("password is too common");
  }
  // no complexity-combo forcing (design: would just produce Passw0rd!)
}

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 19_456, // 19 MiB
    timeCost: 2,
    parallelism: 1,
  });
}

export async function verifyPassword(
  password: string,
  hash: string,
): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}
