import { describe, expect, it } from "vitest";

import { db } from "@/server/db";
import {
  loginLocalUser,
  LocalAuthError,
  MAX_FAILED_LOGINS,
  registerLocalUser,
} from "./local-auth";

const DISABLED = !process.env.TEST_DATABASE_URL;

function uniqueEmail(): string {
  return `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
}

describe.skipIf(DISABLED)("local auth", () => {
  it("registers, logs in and creates a local session", async () => {
    const email = uniqueEmail();
    await registerLocalUser({
      email: `  ${email.toUpperCase()} `,
      password: "correct-horse-battery-9!",
      environment: { LOCAL_REGISTRATION_ENABLED: "true" },
    });

    const login = await loginLocalUser({
      email,
      password: "correct-horse-battery-9!",
    });
    expect(login?.userId).toBeTruthy();

    await db.session.deleteMany({ where: { userId: login?.userId ?? "" } });
    await db.user.deleteMany({ where: { email } });
  });

  it("locks after MAX_FAILED_LOGINS and rejects while locked", async () => {
    const email = uniqueEmail();
    await registerLocalUser({
      email,
      password: "correct-horse-battery-9!",
      environment: { LOCAL_REGISTRATION_ENABLED: "true" },
    });

    for (let i = 0; i < MAX_FAILED_LOGINS; i++) {
      await expect(
        loginLocalUser({ email, password: "wrong-password-123" }),
      ).rejects.toThrow(LocalAuthError);
    }

    await expect(
      loginLocalUser({ email, password: "correct-horse-battery-9!" }),
    ).rejects.toMatchObject({ code: "account_locked" });

    const user = await db.user.findFirst({ where: { email } });
    expect(user?.failedLoginCount).toBe(MAX_FAILED_LOGINS);
    expect(user?.lockedUntil).not.toBeNull();

    await db.user.deleteMany({ where: { email } });
  });

  it("returns identical error for unknown email and wrong password (enumeration resistance)", async () => {
    const email = uniqueEmail();
    const a = await loginLocalUser({
      email,
      password: "some-random-password-1",
    }).catch((e: unknown) => (e as Error).message);
    const b = await loginLocalUser({
      email: "does-not-exist@example.com",
      password: "some-random-password-1",
    }).catch((e: unknown) => (e as Error).message);
    expect(a).toBe(b);
  });

  it("rejects duplicate registration (case-insensitive)", async () => {
    const email = uniqueEmail();
    await registerLocalUser({
      email,
      password: "correct-horse-battery-9!",
      environment: { LOCAL_REGISTRATION_ENABLED: "true" },
    });
    await expect(
      registerLocalUser({
        email: email.toUpperCase(),
        password: "correct-horse-battery-9!",
        environment: { LOCAL_REGISTRATION_ENABLED: "true" },
      }),
    ).rejects.toMatchObject({ code: "email_taken" });
    const count = await db.user.count({ where: { email } });
    expect(count).toBe(1);
    await db.user.deleteMany({ where: { email } });
  });
});
