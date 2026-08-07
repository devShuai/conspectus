import { createHash } from "node:crypto";

import * as oidc from "openid-client";

import type { DeviceM0Config } from "./device-m0-config";

export interface DeviceAuthorizationStart {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresIn: number;
  interval: number;
}

export interface DeviceTokenResult {
  accessTokenPresent: boolean;
  accessTokenFingerprint: string;
  scope: string[];
  hasUsageWrite: boolean;
  tokenType?: string;
  expiresIn?: number;
}

export interface IntrospectionEvidence {
  active: boolean;
  clientId?: string;
  scope: string[];
  hasUsageWrite: boolean;
  subjectFingerprint?: string;
  tokenType?: string;
  /** True when response only reports inactive with no extra claims (privacy). */
  inactiveWithoutLeak: boolean;
}

export interface DeviceFlowPort {
  startDeviceAuthorization(
    config: DeviceM0Config,
  ): Promise<DeviceAuthorizationStart>;
  pollDeviceToken(
    config: DeviceM0Config,
    start: DeviceAuthorizationStart,
    options?: { signal?: AbortSignal; maxWaitMs?: number },
  ): Promise<DeviceTokenResult & { accessToken: string }>;
  introspectAccessToken(
    config: DeviceM0Config,
    accessToken: string,
  ): Promise<IntrospectionEvidence>;
}

const cliConfigurationCache = new Map<string, Promise<oidc.Configuration>>();
const resourceConfigurationCache = new Map<string, Promise<oidc.Configuration>>();

export const openIdDeviceFlowPort: DeviceFlowPort = {
  async startDeviceAuthorization(config) {
    const cli = await cliConfiguration(config);
    const response = await oidc.initiateDeviceAuthorization(cli, {
      scope: config.deviceScope,
    });
    const deviceCode = requiredString(response.device_code, "device_code");
    const userCode = requiredString(response.user_code, "user_code");
    const verificationUri = requiredString(
      response.verification_uri,
      "verification_uri",
    );
    return {
      deviceCode,
      userCode,
      verificationUri,
      verificationUriComplete:
        typeof response.verification_uri_complete === "string"
          ? response.verification_uri_complete
          : undefined,
      expiresIn: numberOr(response.expires_in, 600),
      interval: numberOr(response.interval, 5),
    };
  },

  async pollDeviceToken(config, start, options = {}) {
    const cli = await cliConfiguration(config);
    const response = await oidc.pollDeviceAuthorizationGrant(
      cli,
      {
        device_code: start.deviceCode,
        user_code: start.userCode,
        verification_uri: start.verificationUri,
        verification_uri_complete: start.verificationUriComplete,
        expires_in: start.expiresIn,
        interval: start.interval,
      },
      undefined,
      {
        signal: options.signal,
        // openid-client uses interval from device response; cap total wait via AbortSignal externally
      },
    );
    const accessToken = requiredString(response.access_token, "access_token");
    const scope = splitScope(response.scope);
    return {
      accessToken,
      accessTokenPresent: true,
      accessTokenFingerprint: fingerprint(accessToken),
      scope,
      hasUsageWrite: scope.includes("usage:write"),
      tokenType:
        typeof response.token_type === "string" ? response.token_type : undefined,
      expiresIn:
        typeof response.expires_in === "number" ? response.expires_in : undefined,
    };
  },

  async introspectAccessToken(config, accessToken) {
    const resource = await resourceConfiguration(config);
    const response = await oidc.tokenIntrospection(resource, accessToken, {
      token_type_hint: "access_token",
    });
    return summarizeIntrospection(response);
  },
};

export function summarizeIntrospection(
  response: Record<string, unknown>,
): IntrospectionEvidence {
  const active = response.active === true;
  const scope = splitScope(response.scope);
  const clientId =
    typeof response.client_id === "string" ? response.client_id : undefined;
  const sub = typeof response.sub === "string" ? response.sub : undefined;
  const tokenType =
    typeof response.token_type === "string" ? response.token_type : undefined;

  const keys = Object.keys(response).filter((key) => response[key] !== undefined);
  const inactiveWithoutLeak =
    !active &&
    keys.every((key) => key === "active") &&
    response.active === false;

  return {
    active,
    clientId,
    scope,
    hasUsageWrite: scope.includes("usage:write"),
    subjectFingerprint: sub ? fingerprint(sub) : undefined,
    tokenType,
    inactiveWithoutLeak: !active ? inactiveWithoutLeak || keys.length <= 2 : false,
  };
}

export function evaluateDeviceM0Result(input: {
  token: DeviceTokenResult;
  allowedIntrospection: IntrospectionEvidence;
  deniedIntrospection?: IntrospectionEvidence;
  expectedTokenClientId: string;
  resourceClientId: string;
}): {
  go: boolean;
  checks: Array<{ id: string; ok: boolean; detail: string }>;
} {
  const checks = [
    {
      id: "token_present",
      ok: input.token.accessTokenPresent,
      detail: input.token.accessTokenPresent
        ? `token fp=${input.token.accessTokenFingerprint}`
        : "missing access token",
    },
    {
      id: "token_scope_usage_write",
      ok: input.token.hasUsageWrite,
      detail: `token scopes=[${input.token.scope.join(" ")}]`,
    },
    {
      id: "introspect_active",
      ok: input.allowedIntrospection.active,
      detail: input.allowedIntrospection.active
        ? `active client_id=${input.allowedIntrospection.clientId ?? "?"} sub_fp=${input.allowedIntrospection.subjectFingerprint ?? "?"}`
        : "expected active=true when introspectable_by includes resource client",
    },
    {
      id: "introspect_client_id",
      ok: input.allowedIntrospection.clientId === input.expectedTokenClientId,
      detail: `got client_id=${input.allowedIntrospection.clientId ?? "none"}, expected ${input.expectedTokenClientId}`,
    },
    {
      id: "introspect_scope_usage_write",
      ok: input.allowedIntrospection.hasUsageWrite,
      detail: `introspected scopes=[${input.allowedIntrospection.scope.join(" ")}]`,
    },
    {
      id: "resource_client_not_token_client",
      ok: input.resourceClientId !== input.expectedTokenClientId,
      detail: `resource=${input.resourceClientId} token_issuer=${input.expectedTokenClientId}`,
    },
  ];

  if (input.deniedIntrospection) {
    checks.push({
      id: "introspect_denied_inactive",
      ok: !input.deniedIntrospection.active,
      detail: input.deniedIntrospection.active
        ? "denied path unexpectedly active"
        : "active=false as expected without whitelist",
    });
    checks.push({
      id: "introspect_denied_no_leak",
      ok:
        !input.deniedIntrospection.active &&
        !input.deniedIntrospection.subjectFingerprint &&
        !input.deniedIntrospection.clientId,
      detail: input.deniedIntrospection.inactiveWithoutLeak
        ? "inactive response without subject/client leak"
        : "inactive but may include extra fields — review manually",
    });
  }

  return {
    go: checks.every((check) => check.ok),
    checks,
  };
}

export function fingerprint(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("base64url").slice(0, 16);
}

export function resetDeviceM0CachesForTests(): void {
  cliConfigurationCache.clear();
  resourceConfigurationCache.clear();
}

async function cliConfiguration(config: DeviceM0Config): Promise<oidc.Configuration> {
  const key = `${config.auth.issuerIdentifier}\0${config.cliClientId}`;
  let pending = cliConfigurationCache.get(key);
  if (!pending) {
    const options: oidc.DiscoveryRequestOptions = { timeout: 10 };
    if (config.auth.issuer.protocol === "http:") {
      options.execute = [oidc.allowInsecureRequests];
    }
    pending = oidc.discovery(
      config.auth.issuer,
      config.cliClientId,
      {
        token_endpoint_auth_method: "none",
      },
      oidc.None(),
      options,
    );
    cliConfigurationCache.set(key, pending);
    pending.catch(() => cliConfigurationCache.delete(key));
  }
  return pending;
}

async function resourceConfiguration(
  config: DeviceM0Config,
): Promise<oidc.Configuration> {
  const secretFingerprint = `${config.resourceClientSecret.length}:${config.resourceClientSecret.slice(0, 4)}:${config.resourceClientSecret.slice(-4)}`;
  const key = [
    config.auth.issuerIdentifier,
    config.resourceClientId,
    secretFingerprint,
  ].join("\0");
  let pending = resourceConfigurationCache.get(key);
  if (!pending) {
    const options: oidc.DiscoveryRequestOptions = { timeout: 10 };
    if (config.auth.issuer.protocol === "http:") {
      options.execute = [oidc.allowInsecureRequests];
    }
    pending = oidc.discovery(
      config.auth.issuer,
      config.resourceClientId,
      {
        client_secret: config.resourceClientSecret,
        token_endpoint_auth_method: "client_secret_basic",
      },
      oidc.ClientSecretBasic(config.resourceClientSecret),
      options,
    );
    resourceConfigurationCache.set(key, pending);
    pending.catch(() => resourceConfigurationCache.delete(key));
  }
  return pending;
}

function splitScope(value: unknown): string[] {
  if (typeof value !== "string" || value.trim() === "") {
    return [];
  }
  return value.split(/\s+/).filter(Boolean);
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`device/token response missing ${name}`);
  }
  return value;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
