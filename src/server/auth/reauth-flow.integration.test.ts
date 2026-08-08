import { describe, expect, it } from "vitest";

import { db } from "@/server/db";
import { createPersistentSession } from "./session-db";

import { certusSubjectFromClaims, type OIDCClaims } from "./claims";
import type { AuthConfig } from "./config";
import type { OIDCProvider } from "./provider";
import {
  completeReauthFlow,
  ReauthFlowError,
  startReauthFlow,
} from "./reauth-flow";
import { findReauthTransaction } from "./reauth";

const DISABLED = !process.env.TEST_DATABASE_URL;

const config: AuthConfig = {
  appUrl: new URL("http://127.0.0.1:3000"),
  callbackUrl: new URL("http://127.0.0.1:3000/api/auth/certus/callback"),
  issuer: new URL("http://127.0.0.1:8080"),
  issuerIdentifier: "http://127.0.0.1:8080",
  clientId: "conspectus",
  clientSecret: "test-secret",
  authSecret: "test-auth-secret-with-at-least-32-bytes",
  secureCookies: false,
};

function validClaims(sub: string, authTime: number): OIDCClaims {
  return {
    sub,
    iss: config.issuerIdentifier,
    aud: config.clientId,
    nonce: "test-nonce",
    auth_time: authTime,
  };
}

function mockProvider(claims: OIDCClaims): OIDCProvider {
  return {
    async createRequestSecurity() {
      return {
        state: "test-state",
        nonce: "test-nonce",
        codeVerifier: "test-verifier",
        codeChallenge: "test-challenge",
      };
    },
    async buildAuthorizationURL(_config, security, extraParams) {
      const url = new URL("http://127.0.0.1:8080/oauth2/authorize");
      url.searchParams.set("state", security.state);
      for (const [key, value] of Object.entries(extraParams ?? {})) {
        url.searchParams.set(key, value);
      }
      return url;
    },
    async exchangeAuthorizationCode() {
      return { claims };
    },
  };
}

function callbackUrl(state = "test-state"): URL {
  const url = new URL(config.callbackUrl);
  url.searchParams.set("code", "auth-code");
  url.searchParams.set("state", state);
  return url;
}

function unique(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function makeUserForClaims(claims: OIDCClaims) {
  const derivedSub = certusSubjectFromClaims(claims, config, "test-nonce");
  return db.user.create({
    data: {
      certusSub: derivedSub,
      certusLinkStatus: "active",
      lastStatusSyncedAt: new Date(),
    },
  });
}

describe.skipIf(DISABLED)("reauth flow (#71)", () => {
  it("start issues an authorization URL with prompt=login&max_age=0 and a context", async () => {
    const claims = validClaims(unique("sub-start"), Math.floor(Date.now() / 1000));
    const user = await makeUserForClaims(claims);
    const session = await createPersistentSession({ userId: user.id, authMethod: "certus" });

    const flow = await startReauthFlow({
      userId: user.id,
      sessionId: session.sessionId,
      action: "export",
      targetPath: "/settings/data",
      config,
      provider: mockProvider(claims),
    });

    expect(flow.authorizationUrl.searchParams.get("prompt")).toBe("login");
    expect(flow.authorizationUrl.searchParams.get("max_age")).toBe("0");
    expect(flow.authorizationUrl.searchParams.get("state")).toBe("test-state");

    // #98: the cookie is an opaque token only. The target used to ride along as
    // unsigned base64 JSON, which made it client-editable -> open redirect.
    expect(() =>
      JSON.parse(Buffer.from(flow.reauthContext, "base64url").toString("utf8")),
    ).toThrow();

    const tx = await findReauthTransaction(flow.reauthContext);
    expect(tx?.action).toBe("export");
    expect(tx?.userId).toBe(user.id);
    // target and session binding live on the row, out of the client's reach
    expect(tx?.targetPath).toBe("/settings/data");
    expect(tx?.sessionId).toBe(session.sessionId);

    await db.user.delete({ where: { id: user.id } });
  });

  it("completes a valid round trip and marks the transaction verified", async () => {
    const claims = validClaims(unique("sub-ok"), Math.floor(Date.now() / 1000));
    const user = await makeUserForClaims(claims);
    const session = await createPersistentSession({ userId: user.id, authMethod: "certus" });
    const provider = mockProvider(claims);
    const flow = await startReauthFlow({
      userId: user.id,
      sessionId: session.sessionId,
      action: "export",
      targetPath: "/settings/data",
      config,
      provider,
    });

    const done = await completeReauthFlow({
      currentUrl: callbackUrl(),
      oidcHandle: flow.oidcHandle,
      reauthContext: flow.reauthContext,
      config,
      provider,
    });

    expect(done.action).toBe("export");
    expect(done.targetPath).toBe("/settings/data");
    const tx = await findReauthTransaction(done.token);
    expect(tx?.verifiedAt).not.toBeNull();
    expect(tx?.consumedAt).toBeNull();

    await db.user.delete({ where: { id: user.id } });
  });

  it("rejects a stale auth_time and terminates the transaction", async () => {
    const claims = validClaims(
      unique("sub-stale"),
      Math.floor(Date.now() / 1000) - 7200,
    );
    const user = await makeUserForClaims(claims);
    const session = await createPersistentSession({ userId: user.id, authMethod: "certus" });
    const provider = mockProvider(claims);
    const flow = await startReauthFlow({
      userId: user.id,
      sessionId: session.sessionId,
      action: "export",
      targetPath: "/settings/data",
      config,
      provider,
    });

    await expect(
      completeReauthFlow({
        currentUrl: callbackUrl(),
        oidcHandle: flow.oidcHandle,
        reauthContext: flow.reauthContext,
        config,
        provider,
      }),
    ).rejects.toThrow(ReauthFlowError);

    const context = { token: flow.reauthContext };
    const tx = await findReauthTransaction(context.token);
    expect(tx?.consumedAt).not.toBeNull();

    await db.user.delete({ where: { id: user.id } });
  });

  it("rejects when the callback is a different account", async () => {
    const ownerClaims = validClaims(unique("sub-owner"), Math.floor(Date.now() / 1000));
    const user = await makeUserForClaims(ownerClaims);
    const session = await createPersistentSession({ userId: user.id, authMethod: "certus" });
    const otherClaims = validClaims(unique("sub-other"), Math.floor(Date.now() / 1000));

    const flow = await startReauthFlow({
      userId: user.id,
      sessionId: session.sessionId,
      action: "export",
      targetPath: "/settings/data",
      config,
      provider: mockProvider(otherClaims),
    });

    await expect(
      completeReauthFlow({
        currentUrl: callbackUrl(),
        oidcHandle: flow.oidcHandle,
        reauthContext: flow.reauthContext,
        config,
        provider: mockProvider(otherClaims),
      }),
    ).rejects.toThrow(ReauthFlowError);

    await db.user.delete({ where: { id: user.id } });
  });

  it("rejects a wrong state before any verification", async () => {
    const claims = validClaims(unique("sub-state"), Math.floor(Date.now() / 1000));
    const user = await makeUserForClaims(claims);
    const session = await createPersistentSession({ userId: user.id, authMethod: "certus" });
    const provider = mockProvider(claims);
    const flow = await startReauthFlow({
      userId: user.id,
      sessionId: session.sessionId,
      action: "export",
      targetPath: "/settings/data",
      config,
      provider,
    });

    await expect(
      completeReauthFlow({
        currentUrl: callbackUrl("forged-state"),
        oidcHandle: flow.oidcHandle,
        reauthContext: flow.reauthContext,
        config,
        provider,
      }),
    ).rejects.toThrow(ReauthFlowError);

    const context = { token: flow.reauthContext };
    const tx = await findReauthTransaction(context.token);
    expect(tx?.verifiedAt).toBeNull();

    await db.user.delete({ where: { id: user.id } });
  });
});

describe.skipIf(DISABLED)("reauth hardening (#98 #99)", () => {
  it("refuses an absolute or protocol-relative target at start (#98)", async () => {
    const claims = validClaims(unique("sub-target"), Math.floor(Date.now() / 1000));
    const user = await makeUserForClaims(claims);
    const session = await createPersistentSession({ userId: user.id, authMethod: "certus" });

    // note the escape: the third case must contain a real backslash, which some
    // browsers normalise to "/" and would otherwise become //evil.example
    for (const target of ["https://evil.example", "//evil.example", "/\\evil.example"]) {
      await expect(
        startReauthFlow({
          userId: user.id,
          sessionId: session.sessionId,
          action: "export",
          targetPath: target,
          config,
          provider: mockProvider(claims),
        }),
      ).rejects.toMatchObject({ code: "invalid_context" });
    }

    await db.user.delete({ where: { id: user.id } });
  });

  it("a rewritten context cookie cannot redirect anywhere (#98)", async () => {
    // The old shape was base64(JSON) carrying the target, so this was the whole
    // attack: re-encode with an external target and the callback followed it.
    const forged = Buffer.from(
      JSON.stringify({ token: "whatever", target: "https://evil.example" }),
      "utf8",
    ).toString("base64url");

    await expect(
      completeReauthFlow({
        currentUrl: new URL("http://localhost:3000/api/auth/certus/callback?code=c&state=s"),
        oidcHandle: undefined,
        reauthContext: forged,
        config,
        provider: mockProvider(validClaims(unique("sub-forged"), Math.floor(Date.now() / 1000))),
      }),
    ).rejects.toBeInstanceOf(ReauthFlowError);
  });

  it("binds the transaction to the session that started it (#99)", async () => {
    const claims = validClaims(unique("sub-sess"), Math.floor(Date.now() / 1000));
    const user = await makeUserForClaims(claims);
    const deviceA = await createPersistentSession({ userId: user.id, authMethod: "certus" });
    const deviceB = await createPersistentSession({ userId: user.id, authMethod: "certus" });

    const flow = await startReauthFlow({
      userId: user.id,
      sessionId: deviceA.sessionId,
      action: "export",
      targetPath: "/settings/data",
      config,
      provider: mockProvider(claims),
    });
    const tx = await findReauthTransaction(flow.reauthContext);
    expect(tx?.sessionId).toBe(deviceA.sessionId);
    // same user, different session -> must not be able to consume it
    expect(tx?.sessionId).not.toBe(deviceB.sessionId);

    await db.user.delete({ where: { id: user.id } });
  });
});
