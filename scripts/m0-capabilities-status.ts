/**
 * Non-interactive M0 probes for conspectus#3 / #4:
 * - OpenID discovery claims_supported
 * - GET /api/v1/clients/me/capabilities
 * - GET /api/v1/clients/me/users/{id}/status (404 matrix + optional consented user)
 *
 * Never prints secrets, emails, or raw subjects.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

import { loadAuthConfig } from "../src/server/auth/config";
import {
  evaluateCapabilities,
  evaluateUserStatusContract,
  fetchClientCapabilities,
  fetchOpenIdDiscovery,
  fetchUserStatus,
} from "../src/server/auth/certus-client-api";
import {
  discoveryEmailVerifiedSupported,
} from "../src/server/auth/claim-evidence";

function loadEnvFiles(): void {
  for (const name of [".env.local", ".env"]) {
    const path = resolve(process.cwd(), name);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
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
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }
}

async function main(): Promise<void> {
  loadEnvFiles();
  const config = loadAuthConfig();
  const cliSource = process.env.CERTUS_CLI_CLIENT_ID?.trim() || "conspectus-cli";
  const testUserId = process.env.CERTUS_TEST_USER_ID?.trim();

  console.log("M0 capabilities + user status");
  console.log(
    JSON.stringify(
      {
        issuer: config.issuerIdentifier,
        clientId: config.clientId,
        cliSource,
        hasTestUserId: Boolean(testUserId),
      },
      null,
      2,
    ),
  );

  const discovery = await fetchOpenIdDiscovery(config.issuer);
  const discoveryOk = discoveryEmailVerifiedSupported(discovery.claimsSupported);
  console.log("\nDiscovery:");
  console.log(
    JSON.stringify(
      {
        httpStatus: discovery.rawStatus,
        emailVerifiedSupported: discoveryOk,
        claimsSupportedCount: discovery.claimsSupported.length,
      },
      null,
      2,
    ),
  );

  const capabilities = await fetchClientCapabilities(config, undefined, {
    expectedCliSource: cliSource,
  });
  console.log("\nCapabilities:");
  console.log(JSON.stringify(capabilities, null, 2));
  const capEval = evaluateCapabilities(capabilities);
  for (const check of capEval.checks) {
    console.log(`  [${check.ok ? "ok" : "FAIL"}] ${check.id}: ${check.detail}`);
  }

  const missingUser = await fetchUserStatus(config, randomUUID());
  const invalidId = await fetchUserStatus(config, "not-a-uuid");
  const badSecret = await fetchUserStatus(
    config,
    randomUUID(),
    { clientId: config.clientId, clientSecret: "definitely-wrong-secret" },
  );

  let consented;
  if (testUserId) {
    consented = await fetchUserStatus(config, testUserId);
    console.log("\nConsented user status (redacted):");
    console.log(
      JSON.stringify(
        {
          httpStatus: consented.httpStatus,
          status: consented.status,
          emailVerified: consented.emailVerified,
          hasUpdatedAt: consented.hasUpdatedAt,
          subjectFingerprint: consented.subjectFingerprint,
          leakedProfileFields: consented.leakedProfileFields,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(
      "\nCERTUS_TEST_USER_ID not set — skip consented 200 path; use browser login + GET /api/m0/user-status instead.",
    );
  }

  console.log("\nNegative status probes:");
  console.log(
    JSON.stringify(
      {
        missingUser: {
          httpStatus: missingUser.httpStatus,
          opaque: missingUser.notFoundOpaque,
        },
        invalidId: {
          httpStatus: invalidId.httpStatus,
          opaque: invalidId.notFoundOpaque,
        },
        badSecret: { httpStatus: badSecret.httpStatus },
      },
      null,
      2,
    ),
  );

  const statusEval = evaluateUserStatusContract({
    consented,
    missingUser,
    invalidId,
    badSecret: { httpStatus: badSecret.httpStatus },
  });
  for (const check of statusEval.checks) {
    console.log(`  [${check.ok ? "ok" : "FAIL"}] ${check.id}: ${check.detail}`);
  }

  const go =
    discoveryOk &&
    capEval.go &&
    statusEval.go &&
    (consented ? consented.httpStatus === 200 : true);

  console.log(`\n#4 capabilities provisional: ${capEval.go ? "GO" : "NO-GO"}`);
  console.log(
    `#3 status/discovery partial: ${statusEval.go && discoveryOk ? "GO" : "NO-GO"}`,
  );
  console.log(
    `Overall script: ${go ? "GO" : "NO-GO"}${consented ? "" : " (consented path pending browser or CERTUS_TEST_USER_ID)"}`,
  );

  if (!go) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(
    "m0-capabilities-status failed:",
    error instanceof Error ? error.message : error,
  );
  process.exitCode = 1;
});
