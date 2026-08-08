import { describe, expect, it } from "vitest";

import { loadAuthConfig } from "./config";

const baseEnvironment = {
  NODE_ENV: "test",
  APP_URL: "http://127.0.0.1:3000",
  CERTUS_ISSUER: "http://127.0.0.1:8080",
  CERTUS_CLIENT_ID: "conspectus",
  CERTUS_CLIENT_SECRET: "test-secret",
  AUTH_SECRET: "test-auth-secret-with-at-least-32-bytes",
};

describe("loadAuthConfig", () => {
  it("derives the exact callback URL for loopback development", () => {
    const config = loadAuthConfig(baseEnvironment);

    expect(config.callbackUrl.href).toBe(
      "http://127.0.0.1:3000/api/auth/certus/callback",
    );
    expect(config.issuerIdentifier).toBe("http://127.0.0.1:8080");
    expect(config.secureCookies).toBe(false);
  });

  it.each([
    ["missing secret", { ...baseEnvironment, CERTUS_CLIENT_SECRET: "" }],
    ["missing auth secret", { ...baseEnvironment, AUTH_SECRET: "" }],
    ["short auth secret", { ...baseEnvironment, AUTH_SECRET: "too-short" }],
    ["application path", { ...baseEnvironment, APP_URL: "http://127.0.0.1:3000/app" }],
    ["embedded credentials", { ...baseEnvironment, CERTUS_ISSUER: "https://user:pass@auth.example.com" }],
    ["remote development HTTP", { ...baseEnvironment, CERTUS_ISSUER: "http://auth.example.com" }],
    ["production application HTTP", { ...baseEnvironment, NODE_ENV: "production" }],
  ])("rejects %s", (_name, environment) => {
    expect(() => loadAuthConfig(environment)).toThrow();
  });

  it("accepts HTTPS production endpoints and enables Secure cookies", () => {
    const config = loadAuthConfig({
      ...baseEnvironment,
      NODE_ENV: "production",
      APP_URL: "https://conspectus.example.com",
      CERTUS_ISSUER: "https://auth.example.com",
    });

    expect(config.secureCookies).toBe(true);
  });
});
