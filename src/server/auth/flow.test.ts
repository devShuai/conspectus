import { beforeEach, describe, expect, it, vi } from "vitest";

import type { OIDCClaims } from "./claims";
import { loadAuthConfig } from "./config";
import {
  canonicalOIDCCallbackURL,
  completeOIDCLogin,
  OIDCFlowError,
  startOIDCLogin,
  type OIDCTokenResult,
} from "./flow";
import { memorySessionWriter } from "./memory-session-writer";
import { AccountSuspendedError } from "./login-policy";
import type { OIDCProvider, RequestSecurity } from "./provider";
import {
  appSessionStorageKeysForTests,
  deleteAppSession,
  findAppSession,
  resetAppSessionsForTests,
} from "./session";
import {
  OIDC_TRANSACTION_TTL_MS,
  peekOIDCTransaction,
} from "./transaction";

const config = loadAuthConfig({
  NODE_ENV: "test",
  APP_URL: "http://127.0.0.1:3000",
  CERTUS_ISSUER: "http://127.0.0.1:8080",
  CERTUS_CLIENT_ID: "conspectus",
  CERTUS_CLIENT_SECRET: "test-secret",
  AUTH_SECRET: "test-auth-secret-with-at-least-32-bytes",
});

const security: RequestSecurity = {
  state: "state-value",
  nonce: "nonce-value",
  codeVerifier: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~",
  codeChallenge: "challenge-value",
};

function validClaims(overrides: OIDCClaims = {}): OIDCClaims {
  return {
    iss: config.issuerIdentifier,
    sub: "certus-user-id",
    aud: config.clientId,
    nonce: security.nonce,
    ...overrides,
  };
}

function fakeProvider(claims: OIDCClaims = validClaims()): OIDCProvider & {
  exchangeAuthorizationCode: ReturnType<typeof vi.fn>;
} {
  const exchangeAuthorizationCode = vi.fn(async () => {
    const result: OIDCTokenResult = {
      claims,
      refreshToken: "refresh-token-value",
      idToken: "id-token-value",
    };
    return result;
  });
  return {
    async refreshTokens() {
      return {};
    },
    async createRequestSecurity() {
      return security;
    },
    async buildAuthorizationURL(authConfig, requestSecurity) {
      const url = new URL("/oauth2/authorize", authConfig.issuer);
      url.searchParams.set("client_id", authConfig.clientId);
      url.searchParams.set("redirect_uri", authConfig.callbackUrl.href);
      url.searchParams.set("state", requestSecurity.state);
      url.searchParams.set("nonce", requestSecurity.nonce);
      url.searchParams.set("code_challenge", requestSecurity.codeChallenge);
      return url;
    },
    exchangeAuthorizationCode,
  };
}

async function begin(provider = fakeProvider(), now = 10_000) {
  return startOIDCLogin({ config, provider, now });
}

function callbackURL(state = security.state): URL {
  const url = new URL(config.callbackUrl);
  url.searchParams.set("code", "authorization-code");
  url.searchParams.set("state", state);
  return url;
}

describe("OIDC login flow", () => {
  beforeEach(() => {
    resetAppSessionsForTests();
  });

  it("creates a signed transaction cookie and an opaque local session", async () => {
    const provider = fakeProvider();
    const started = await begin(provider);

    expect(started.authorizationUrl.searchParams.get("redirect_uri")).toBe(
      config.callbackUrl.href,
    );
    expect(started.authorizationUrl.searchParams.get("state")).toBe(security.state);
    expect(started.authorizationUrl.searchParams.get("nonce")).toBe(security.nonce);
    expect(
      peekOIDCTransaction(started.transactionHandle, config.authSecret, 10_001),
    ).toMatchObject({
      state: security.state,
      nonce: security.nonce,
      codeVerifier: security.codeVerifier,
      purpose: "login",
    });

    const completed = await completeOIDCLogin(
      callbackURL(),
      started.transactionHandle,
      { config, provider, sessions: memorySessionWriter, now: 10_001 },
    );

    // #94: the identity carried forward is certus's raw `sub`, not a digest --
    // Back-Channel Logout and the status endpoint both need the real value.
    expect(completed.userId).toBe("certus-user-id");
    expect(findAppSession(completed.sessionToken, 10_002)?.userId).toBe(
      completed.userId,
    );
    expect(appSessionStorageKeysForTests()).not.toContain(completed.sessionToken);
    expect(provider.exchangeAuthorizationCode).toHaveBeenCalledOnce();

    provider.exchangeAuthorizationCode.mockRejectedValueOnce(
      new Error("authorization code was already consumed"),
    );
    await expect(
      completeOIDCLogin(callbackURL(), started.transactionHandle, {
        config,
        provider,
        sessions: memorySessionWriter,
        now: 10_003,
      }),
    ).rejects.toMatchObject({ code: "authorization_response_rejected" });

    deleteAppSession(completed.sessionToken);
    expect(findAppSession(completed.sessionToken, 10_004)).toBeNull();
  });

  it("uses the configured callback origin with runtime query parameters", () => {
    const runtimeUrl = new URL(
      "http://localhost:3000/api/auth/certus/callback?code=authorization-code&state=first&state=second",
    );

    const callbackUrl = canonicalOIDCCallbackURL(
      config,
      runtimeUrl.searchParams,
    );

    expect(callbackUrl.origin).toBe("http://127.0.0.1:3000");
    expect(callbackUrl.pathname).toBe(config.callbackUrl.pathname);
    expect(callbackUrl.searchParams.get("code")).toBe("authorization-code");
    expect(callbackUrl.searchParams.getAll("state")).toEqual(["first", "second"]);
    expect(callbackUrl.hash).toBe("");
  });

  it("rejects wrong or repeated state before token exchange", async () => {
    for (const currentUrl of [
      callbackURL("attacker-state"),
      new URL(`${callbackURL().href}&state=${security.state}`),
    ]) {
      const provider = fakeProvider();
      const started = await begin(provider);
      await expect(
        completeOIDCLogin(currentUrl, started.transactionHandle, {
          config,
          provider,
          sessions: memorySessionWriter,
          now: 10_001,
        }),
      ).rejects.toMatchObject({ code: "invalid_state" });
      expect(provider.exchangeAuthorizationCode).not.toHaveBeenCalled();
    }
  });

  it("rejects a wrong callback origin or path", async () => {
    const provider = fakeProvider();
    const started = await begin(provider);
    const wrongCallback = new URL(callbackURL());
    wrongCallback.pathname = "/api/auth/certus/other";

    await expect(
      completeOIDCLogin(wrongCallback, started.transactionHandle, {
        config,
        provider,
        sessions: memorySessionWriter,
        now: 10_001,
      }),
    ).rejects.toMatchObject({ code: "invalid_callback_url" });
  });

  it("rejects expired transactions", async () => {
    const provider = fakeProvider();
    const started = await begin(provider);

    await expect(
      completeOIDCLogin(callbackURL(), started.transactionHandle, {
        config,
        provider,
        sessions: memorySessionWriter,
        now: 10_000 + OIDC_TRANSACTION_TTL_MS,
      }),
    ).rejects.toMatchObject({ code: "invalid_transaction" });
  });

  it.each([
    ["nonce", { nonce: "wrong-nonce" }],
    ["issuer", { iss: "https://attacker.example.com" }],
    ["audience", { aud: "other-client" }],
  ])("rejects a wrong %s claim", async (_name, override) => {
    const provider = fakeProvider(validClaims(override));
    const started = await begin(provider);

    await expect(
      completeOIDCLogin(callbackURL(), started.transactionHandle, {
        config,
        provider,
        sessions: memorySessionWriter,
        now: 10_001,
      }),
    ).rejects.toMatchObject({ code: "invalid_claims" });
    expect(appSessionStorageKeysForTests()).toHaveLength(0);
  });

  it("does not expose token exchange failures", async () => {
    const provider = fakeProvider();
    provider.exchangeAuthorizationCode.mockRejectedValue(
      new Error("upstream response contained a sensitive token"),
    );
    const started = await begin(provider);

    let caught: unknown;
    try {
      await completeOIDCLogin(callbackURL(), started.transactionHandle, {
        config,
        provider,
        sessions: memorySessionWriter,
        now: 10_001,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(OIDCFlowError);
    expect((caught as OIDCFlowError).code).toBe("authorization_response_rejected");
    expect((caught as Error).message).not.toContain("sensitive token");
  });

  it("maps a final Session-boundary suspension to a safe flow error", async () => {
    const provider = fakeProvider();
    const started = await begin(provider);
    const sessions = {
      ...memorySessionWriter,
      async create(): Promise<never> {
        throw new AccountSuspendedError();
      },
    };

    await expect(
      completeOIDCLogin(callbackURL(), started.transactionHandle, {
        config,
        provider,
        sessions,
        now: 10_001,
      }),
    ).rejects.toMatchObject({ code: "account_suspended" });
  });
});
