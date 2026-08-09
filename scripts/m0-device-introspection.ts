/**
 * Retained M0 verification tool (kept per conspectus#122): interactive E2E
 * for conspectus#6 — device code + usage:write + cross-client introspection.
 *
 * When to use: run manually to diagnose the certus device-authorization /
 * introspection chain (e.g. after certus upgrades or config changes);
 * requires the device-m0 config in .env.local. Not part of CI.
 * Evidence and conclusions: docs/m0-device-introspection.md.
 *
 * Never prints access tokens, refresh tokens, client secrets, or raw subjects.
 *
 * Usage:
 *   npm run m0:device-introspect
 *   npm run m0:device-introspect -- --deny-probe
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

import { loadDeviceM0Config } from "../src/server/auth/device-m0-config";
import {
  evaluateDeviceM0Result,
  openIdDeviceFlowPort,
  type IntrospectionEvidence,
} from "../src/server/auth/device-introspection";

function loadEnvFiles(): void {
  for (const name of [".env.local", ".env"]) {
    const path = resolve(process.cwd(), name);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  }
}

async function main(): Promise<void> {
  loadEnvFiles();
  const denyProbe = process.argv.includes("--deny-probe");
  const config = loadDeviceM0Config();
  const port = openIdDeviceFlowPort;

  console.log("M0 device + introspection");
  console.log(
    JSON.stringify(
      {
        issuer: config.auth.issuerIdentifier,
        cliClientId: config.cliClientId,
        resourceClientId: config.resourceClientId,
        deviceScope: config.deviceScope,
        denyProbe,
      },
      null,
      2,
    ),
  );

  const start = await port.startDeviceAuthorization(config);
  console.log("\nApprove this device authorization in a browser:");
  console.log(`  user_code: ${start.userCode}`);
  console.log(`  verification_uri: ${start.verificationUri}`);
  if (start.verificationUriComplete) {
    console.log(`  verification_uri_complete: ${start.verificationUriComplete}`);
  }
  console.log(
    `\nPolling token endpoint (interval=${start.interval}s, expires_in=${start.expiresIn}s)...`,
  );

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    Math.max(30_000, start.expiresIn * 1000),
  );

  let token;
  try {
    token = await port.pollDeviceToken(config, start, {
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  console.log("\nDevice token (redacted):");
  console.log(
    JSON.stringify(
      {
        accessTokenPresent: token.accessTokenPresent,
        accessTokenFingerprint: token.accessTokenFingerprint,
        scope: token.scope,
        hasUsageWrite: token.hasUsageWrite,
        tokenType: token.tokenType,
        expiresIn: token.expiresIn,
      },
      null,
      2,
    ),
  );

  const allowed = await port.introspectAccessToken(config, token.accessToken);
  console.log("\nIntrospection by resource client (whitelist expected):");
  console.log(JSON.stringify(redactIntrospection(allowed), null, 2));

  let denied: IntrospectionEvidence | undefined;
  if (denyProbe) {
    console.log(
      "\n--deny-probe: re-run after removing introspectable_by on the CLI client,",
    );
    console.log(
      "then set CERTUS_DENY_PROBE_TOKEN_FP to this token fingerprint and pass the token via stdin is NOT supported.",
    );
    console.log(
      "Instead: keep whitelist off, re-run without --deny-probe once, then compare active=false.",
    );
  }

  const evaluation = evaluateDeviceM0Result({
    token,
    allowedIntrospection: allowed,
    deniedIntrospection: denied,
    expectedTokenClientId: config.expectedTokenClientId,
    resourceClientId: config.resourceClientId,
  });

  console.log("\nChecks:");
  for (const check of evaluation.checks) {
    console.log(`  [${check.ok ? "ok" : "FAIL"}] ${check.id}: ${check.detail}`);
  }
  console.log(`\nM4 auth path provisional: ${evaluation.go ? "GO" : "NO-GO / fix config"}`);

  // Best-effort negative path without second client: garbage token must be inactive.
  const garbage = await port.introspectAccessToken(
    config,
    "not-a-real-access-token",
  );
  console.log("\nGarbage token introspection:");
  console.log(JSON.stringify(redactIntrospection(garbage), null, 2));
  if (garbage.active) {
    console.error("FAIL: garbage token reported active");
    process.exitCode = 1;
    return;
  }

  if (!evaluation.go) {
    process.exitCode = 1;
  }
}

function redactIntrospection(value: IntrospectionEvidence) {
  return {
    active: value.active,
    clientId: value.clientId,
    scope: value.scope,
    hasUsageWrite: value.hasUsageWrite,
    subjectFingerprint: value.subjectFingerprint,
    tokenType: value.tokenType,
    inactiveWithoutLeak: value.inactiveWithoutLeak,
  };
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error("m0-device-introspection failed:", message);
  process.exitCode = 1;
});
