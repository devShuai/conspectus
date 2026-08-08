import { describe, expect, it, vi } from "vitest";

import { db } from "@/server/db";
import { BindError } from "./bind";
import { BindFlowError, completeBindFlow, startBindFlow } from "./bind-flow";
import type { AuthConfig } from "./config";
import type { OIDCProvider } from "./provider";
import { createOIDCTransaction } from "./transaction";

const DISABLED = !process.env.TEST_DATABASE_URL;

const config = {
  issuer: new URL("https://certus.test"),
  issuerIdentifier: "https://certus.test",
  clientId: "conspectus",
  clientSecret: "s",
  authSecret: "test-auth-secret-with-at-least-32-bytes",
  appUrl: new URL("http://localhost:3000"),
} as unknown as AuthConfig;

function uniqueSub(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Provider stub whose ID Token claims are the only source of `sub`. */
function providerReturning(sub: string, nonce: string): OIDCProvider {
  return {
    createRequestSecurity: vi.fn().mockResolvedValue({
      state: "st",
      nonce,
      codeVerifier: "cv",
    }),
    buildAuthorizationURL: vi
      .fn()
      .mockResolvedValue(new URL("https://certus.test/oauth2/authorize")),
    exchangeAuthorizationCode: vi.fn().mockResolvedValue({
      claims: {
        sub,
        iss: "https://certus.test",
        aud: "conspectus",
        nonce,
      },
      refreshToken: "r",
      idToken: "i",
    }),
  } as unknown as OIDCProvider;
}

async function localUser() {
  return db.user.create({
    data: {
      email: `${uniqueSub("bind")}@example.com`,
      passwordHash: "x",
      emailVerifiedAt: new Date(),
      emailVerificationSource: "local",
    },
  });
}

function callbackUrl(state = "st"): URL {
  return new URL(`http://localhost:3000/api/auth/certus/callback?code=c&state=${state}`);
}

describe.skipIf(DISABLED)("bind via certus authorization (#96)", () => {
  it("binds the sub from the ID Token, not from client input", async () => {
    const user = await localUser();
    const sub = uniqueSub("real");
    const provider = providerReturning(sub, "n1");

    const started = await startBindFlow({ userId: user.id, config, provider });
    const done = await completeBindFlow({
      currentUrl: callbackUrl(),
      oidcHandle: started.oidcHandle,
      sessionUserId: user.id,
      config,
      provider,
    });

    expect(done.certusSub).toBe(sub);
    const after = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.certusSub).toBe(sub);
    expect(after.certusLinkStatus).toBe("active");
  });

  it("refuses a login transaction replayed as a bind", async () => {
    const user = await localUser();
    const provider = providerReturning(uniqueSub("x"), "n2");
    // a plain login transaction: no purpose, no bindUserId
    const { handle } = createOIDCTransaction(
      {
        state: "st",
        nonce: "n2",
        codeVerifier: "cv",
      },
      config.authSecret,
    );

    await expect(
      completeBindFlow({
        currentUrl: callbackUrl(),
        oidcHandle: handle,
        sessionUserId: user.id,
        config,
        provider,
      }),
    ).rejects.toMatchObject({ code: "not_a_bind_transaction" });
  });

  it("refuses when a different session finishes the flow", async () => {
    const starter = await localUser();
    const attacker = await localUser();
    const provider = providerReturning(uniqueSub("y"), "n3");

    const started = await startBindFlow({ userId: starter.id, config, provider });
    await expect(
      completeBindFlow({
        currentUrl: callbackUrl(),
        oidcHandle: started.oidcHandle,
        sessionUserId: attacker.id,
        config,
        provider,
      }),
    ).rejects.toMatchObject({ code: "session_mismatch" });

    const untouched = await db.user.findUniqueOrThrow({ where: { id: attacker.id } });
    expect(untouched.certusSub).toBeNull();
  });

  it("refuses a state that does not match the transaction", async () => {
    const user = await localUser();
    const provider = providerReturning(uniqueSub("z"), "n4");
    const started = await startBindFlow({ userId: user.id, config, provider });

    await expect(
      completeBindFlow({
        currentUrl: callbackUrl("tampered"),
        oidcHandle: started.oidcHandle,
        sessionUserId: user.id,
        config,
        provider,
      }),
    ).rejects.toBeInstanceOf(BindFlowError);
  });

  it("refuses a sub already bound to another account", async () => {
    const owner = await db.user.create({
      data: {
        certusSub: uniqueSub("owned"),
        certusLinkStatus: "active",
        lastStatusSyncedAt: new Date(),
      },
    });
    const squatter = await localUser();
    const provider = providerReturning(owner.certusSub!, "n5");

    const started = await startBindFlow({ userId: squatter.id, config, provider });
    await expect(
      completeBindFlow({
        currentUrl: callbackUrl(),
        oidcHandle: started.oidcHandle,
        sessionUserId: squatter.id,
        config,
        provider,
      }),
    ).rejects.toBeInstanceOf(BindError);

    const after = await db.user.findUniqueOrThrow({ where: { id: squatter.id } });
    expect(after.certusSub).toBeNull();
  });

  it("cannot reuse the same authorization code to bind twice", async () => {
    const user = await localUser();
    const provider = providerReturning(uniqueSub("once"), "n6");
    const started = await startBindFlow({ userId: user.id, config, provider });

    await completeBindFlow({
      currentUrl: callbackUrl(),
      oidcHandle: started.oidcHandle,
      sessionUserId: user.id,
      config,
      provider,
    });
    vi.mocked(provider.exchangeAuthorizationCode).mockRejectedValueOnce(
      new Error("authorization code was already consumed"),
    );
    await expect(
      completeBindFlow({
        currentUrl: callbackUrl(),
        oidcHandle: started.oidcHandle,
        sessionUserId: user.id,
        config,
        provider,
      }),
    ).rejects.toMatchObject({ code: "authorization_response_rejected" });
  });
});
