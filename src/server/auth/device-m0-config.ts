import { loadAuthConfig, type AuthConfig } from "./config.js";

export interface DeviceM0Config {
  auth: AuthConfig;
  cliClientId: string;
  resourceClientId: string;
  resourceClientSecret: string;
  deviceScope: string;
  expectedTokenClientId: string;
}

type Env = Record<string, string | undefined>;

export function loadDeviceM0Config(environment: Env = process.env): DeviceM0Config {
  const auth = loadAuthConfig(environment);
  const cliClientId = required("CERTUS_CLI_CLIENT_ID", environment.CERTUS_CLI_CLIENT_ID);
  const resourceClientId = required(
    "CERTUS_RESOURCE_CLIENT_ID",
    environment.CERTUS_RESOURCE_CLIENT_ID ?? environment.CERTUS_CLIENT_ID,
  );
  const resourceClientSecret = required(
    "CERTUS_RESOURCE_CLIENT_SECRET",
    environment.CERTUS_RESOURCE_CLIENT_SECRET ?? environment.CERTUS_CLIENT_SECRET,
  );
  const deviceScope =
    environment.CERTUS_CLI_SCOPE?.trim() || "openid profile usage:write";
  const expectedTokenClientId =
    environment.CERTUS_CLI_EXPECTED_CLIENT_ID?.trim() || cliClientId;

  return {
    auth,
    cliClientId,
    resourceClientId,
    resourceClientSecret,
    deviceScope,
    expectedTokenClientId,
  };
}

function required(name: string, value: string | undefined): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new Error(`${name} is required`);
  }
  return normalized;
}
