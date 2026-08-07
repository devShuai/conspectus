/**
 * Interactive admin account creation (local mode, verified by default).
 *
 * The password is prompted on the TTY and NEVER accepted as a CLI argument
 * (design §7.1: avoids shell history / process list exposure).
 *
 * Usage:
 *   npx tsx scripts/admin-create-user.ts
 */
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { db } from "../src/server/db";
import { normalizeEmail } from "../src/server/auth/email";
import { assertStrongPassword, hashPassword } from "../src/server/auth/password";

function loadEnvFiles(): void {
  const { readFileSync, existsSync } = require("node:fs");
  const { resolve } = require("node:path");
  for (const name of [".env.local", ".env"]) {
    const path = resolve(process.cwd(), name);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim();
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }
}

async function main(): Promise<void> {
  loadEnvFiles();
  const rl = createInterface({ input, output });

  const emailRaw = await rl.question("Email: ");
  const email = normalizeEmail(emailRaw);
  const password = await rl.question("Password (min 12 chars, not echoed): ");
  rl.close();

  assertStrongPassword(password);
  const existing = await db.user.findFirst({
    where: { email, passwordHash: { not: null } },
  });
  if (existing) {
    throw new Error("a local account with this email already exists");
  }

  const passwordHash = await hashPassword(password);
  const user = await db.user.create({
    data: {
      email,
      passwordHash,
      emailVerifiedAt: new Date(),
      emailVerificationSource: "local",
    },
  });
  console.log(`Created verified local account: ${user.id}`);
}

main().catch((error: unknown) => {
  console.error(
    "admin-create-user failed:",
    error instanceof Error ? error.message : error,
  );
  process.exitCode = 1;
});
