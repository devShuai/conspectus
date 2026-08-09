import type { AuthConfig } from "./config";
import { fingerprint } from "./device-introspection";

export interface CapabilitiesEvidence {
  httpStatus: number;
  schemaVersion?: number;
  features: string[];
  introspectionSources: string[];
  configRevision?: string;
  hasClientUserStatus: boolean;
  hasEmailVerifiedFeature: boolean;
  hasCrossClientIntrospection: boolean;
  includesCliSource: boolean;
  cacheControl?: string | null;
}

export interface UserStatusEvidence {
  httpStatus: number;
  active?: boolean;
  status?: string;
  /**
   * certus#10：与 emailVerified 成对返回的地址。缺省表示 certus 版本过旧或本
   * 客户端没有 email scope —— 此时无法完成成对校验，调用方必须 fail-closed。
   */
  email?: string;
  emailVerified?: boolean;
  hasUpdatedAt: boolean;
  updatedAt?: Date;
  subjectFingerprint?: string;
  /** True when 404 body is empty or non-enumerating. */
  notFoundOpaque: boolean;
  retryAfter?: string | null;
  leakedProfileFields: string[];
}

/** updated_at：RFC3339 字符串，或 epoch 数字（>1e12 按毫秒、否则按秒）。 */
function parseUpdatedAt(value: unknown): Date | undefined {
  let date: Date;
  if (typeof value === "number") {
    date = new Date(value > 1e12 ? value : value * 1000);
  } else if (typeof value === "string" && value.length > 0) {
    date = new Date(value);
  } else {
    return undefined;
  }
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export async function fetchOpenIdDiscovery(issuer: URL): Promise<{
  claimsSupported: string[];
  rawStatus: number;
}> {
  const url = new URL("/.well-known/openid-configuration", issuer);
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    cache: "no-store",
  });
  const body = (await response.json()) as { claims_supported?: unknown };
  const claimsSupported = Array.isArray(body.claims_supported)
    ? body.claims_supported.filter((item): item is string => typeof item === "string")
    : [];
  return { claimsSupported, rawStatus: response.status };
}

export async function fetchClientCapabilities(
  config: AuthConfig,
  credentials: { clientId: string; clientSecret: string } = {
    clientId: config.clientId,
    clientSecret: config.clientSecret,
  },
  options: { expectedCliSource?: string } = {},
): Promise<CapabilitiesEvidence> {
  const url = new URL("/api/v1/clients/me/capabilities", config.issuer);
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      authorization: basicAuth(credentials.clientId, credentials.clientSecret),
    },
    cache: "no-store",
  });
  const cacheControl = response.headers.get("cache-control");
  if (!response.ok) {
    return {
      httpStatus: response.status,
      features: [],
      introspectionSources: [],
      hasClientUserStatus: false,
      hasEmailVerifiedFeature: false,
      hasCrossClientIntrospection: false,
      includesCliSource: false,
      cacheControl,
    };
  }
  const body = (await response.json()) as {
    schema_version?: number;
    features?: unknown;
    introspection_sources?: unknown;
    config_revision?: string;
  };
  const features = stringArray(body.features);
  const introspectionSources = stringArray(body.introspection_sources);
  const expectedCli = options.expectedCliSource ?? "conspectus-cli";
  return {
    httpStatus: response.status,
    schemaVersion: body.schema_version,
    features,
    introspectionSources,
    configRevision:
      typeof body.config_revision === "string" ? body.config_revision : undefined,
    hasClientUserStatus: features.includes("client_user_status"),
    hasEmailVerifiedFeature: features.includes("email_verified"),
    hasCrossClientIntrospection: features.includes("cross_client_introspection"),
    includesCliSource: introspectionSources.includes(expectedCli),
    cacheControl,
  };
}

export async function fetchUserStatus(
  config: AuthConfig,
  userId: string,
  credentials: { clientId: string; clientSecret: string } = {
    clientId: config.clientId,
    clientSecret: config.clientSecret,
  },
): Promise<UserStatusEvidence> {
  const url = new URL(
    `/api/v1/clients/me/users/${encodeURIComponent(userId)}/status`,
    config.issuer,
  );
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      authorization: basicAuth(credentials.clientId, credentials.clientSecret),
    },
    cache: "no-store",
  });
  const retryAfter = response.headers.get("retry-after");
  const text = await response.text();
  if (response.status === 404) {
    return {
      httpStatus: 404,
      hasUpdatedAt: false,
      notFoundOpaque: text.trim() === "" || !looksLikeUserEnumeration(text),
      retryAfter,
      leakedProfileFields: [],
    };
  }
  if (!response.ok) {
    return {
      httpStatus: response.status,
      hasUpdatedAt: false,
      notFoundOpaque: false,
      retryAfter,
      leakedProfileFields: [],
    };
  }
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {
      httpStatus: response.status,
      hasUpdatedAt: false,
      notFoundOpaque: false,
      retryAfter,
      leakedProfileFields: [],
    };
  }
  // certus#10 起 email 是这个端点的契约字段，不再是泄漏：它必须与 email_verified
  // 成对返回，否则后台任务无从判断那个布尔说的是不是自己留存的地址。username /
  // name / preferred_username 仍然一个都不该出现。
  const leakedProfileFields = ["username", "name", "preferred_username"].filter(
    (key) => key in body,
  );
  const sub = typeof body.sub === "string" ? body.sub : undefined;
  const status = typeof body.status === "string" ? body.status : undefined;
  const updatedAtRaw = body.updated_at;
  return {
    httpStatus: response.status,
    active: status === "active",
    status,
    email:
      typeof body.email === "string" && body.email.length > 0 ? body.email : undefined,
    emailVerified:
      typeof body.email_verified === "boolean" ? body.email_verified : undefined,
    hasUpdatedAt:
      (typeof updatedAtRaw === "string" && updatedAtRaw.length > 0) ||
      typeof updatedAtRaw === "number",
    updatedAt: parseUpdatedAt(updatedAtRaw),
    subjectFingerprint: sub ? fingerprint(sub) : undefined,
    notFoundOpaque: false,
    retryAfter,
    leakedProfileFields,
  };
}

export function evaluateCapabilities(evidence: CapabilitiesEvidence): {
  go: boolean;
  checks: Array<{ id: string; ok: boolean; detail: string }>;
} {
  const checks = [
    {
      id: "http_200",
      ok: evidence.httpStatus === 200,
      detail: `status=${evidence.httpStatus}`,
    },
    {
      id: "schema_version",
      ok: evidence.schemaVersion === 1,
      detail: `schema_version=${evidence.schemaVersion ?? "missing"}`,
    },
    {
      id: "feature_client_user_status",
      ok: evidence.hasClientUserStatus,
      detail: `features=[${evidence.features.join(",")}]`,
    },
    {
      id: "feature_email_verified",
      ok: evidence.hasEmailVerifiedFeature,
      detail: evidence.hasEmailVerifiedFeature ? "present" : "missing",
    },
    {
      id: "feature_cross_client_introspection",
      ok: evidence.hasCrossClientIntrospection,
      detail: evidence.hasCrossClientIntrospection ? "present" : "missing",
    },
    {
      id: "introspection_sources_cli",
      ok: evidence.includesCliSource,
      detail: `sources=[${evidence.introspectionSources.join(",")}]`,
    },
    {
      id: "no_store",
      ok: (evidence.cacheControl ?? "").toLowerCase().includes("no-store"),
      detail: `cache-control=${evidence.cacheControl ?? "missing"}`,
    },
  ];
  return { go: checks.every((c) => c.ok), checks };
}

export function evaluateUserStatusContract(input: {
  consented?: UserStatusEvidence;
  missingUser: UserStatusEvidence;
  invalidId: UserStatusEvidence;
  badSecret: { httpStatus: number };
}): { go: boolean; checks: Array<{ id: string; ok: boolean; detail: string }> } {
  const checks: Array<{ id: string; ok: boolean; detail: string }> = [
    {
      id: "missing_user_404",
      ok: input.missingUser.httpStatus === 404 && input.missingUser.notFoundOpaque,
      detail: `status=${input.missingUser.httpStatus} opaque=${input.missingUser.notFoundOpaque}`,
    },
    {
      id: "invalid_id_404",
      ok: input.invalidId.httpStatus === 404 && input.invalidId.notFoundOpaque,
      detail: `status=${input.invalidId.httpStatus} opaque=${input.invalidId.notFoundOpaque}`,
    },
    {
      id: "bad_secret_rejected",
      ok: input.badSecret.httpStatus === 401 || input.badSecret.httpStatus === 403,
      detail: `status=${input.badSecret.httpStatus}`,
    },
  ];
  if (input.consented) {
    checks.unshift(
      {
        id: "consented_200",
        ok: input.consented.httpStatus === 200,
        detail: `status=${input.consented.httpStatus}`,
      },
      {
        id: "consented_fields",
        ok:
          !!input.consented.status &&
          typeof input.consented.emailVerified === "boolean" &&
          input.consented.hasUpdatedAt &&
          !!input.consented.subjectFingerprint,
        detail: `user_status=${input.consented.status} email_verified=${String(input.consented.emailVerified)} updated_at=${input.consented.hasUpdatedAt} sub_fp=${input.consented.subjectFingerprint ?? "?"}`,
      },
      {
        // certus#10：验证位必须带着它所描述的地址一起来，否则后台投递只能
        // fail-closed 延迟。这条检查的是探针账号确实收到了成对响应。
        id: "email_paired_with_verification",
        ok: input.consented.email !== undefined,
        detail:
          input.consented.email !== undefined
            ? "email present alongside email_verified"
            : "email missing — certus too old, or this client lacks the email scope",
      },
      {
        id: "no_profile_leak",
        ok: input.consented.leakedProfileFields.length === 0,
        detail:
          input.consented.leakedProfileFields.length === 0
            ? "no username/name fields"
            : `leaked=${input.consented.leakedProfileFields.join(",")}`,
      },
    );
  }
  return { go: checks.every((c) => c.ok), checks };
}

function basicAuth(clientId: string, clientSecret: string): string {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64")}`;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string");
}

function looksLikeUserEnumeration(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes("not found") ||
    lower.includes("does not exist") ||
    lower.includes("no such user") ||
    lower.includes("unknown user")
  );
}
