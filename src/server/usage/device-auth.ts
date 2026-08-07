import { createRemoteJWKSet, jwtVerify } from "jose";

import { loadAuthConfig } from "@/server/auth/config";

const introspectionCache = new Map<string, { sub: string; until: number }>();
const CACHE_TTL_MS = 45_000;

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

/**
 * Validate a collector access token via certus introspection and map to a
 * local user. Results are cached briefly (30–60s, design §7.4).
 */
export async function introspectCliToken(
  authorization: string | null | undefined,
): Promise<string | null> {
  if (!authorization?.startsWith("Bearer ")) return null;
  const accessToken = authorization.slice("Bearer ".length);
  const cached = introspectionCache.get(accessToken);
  if (cached && cached.until > Date.now()) return cached.sub;

  const config = loadAuthConfig();
  const response = await fetch(
    new URL("/oauth2/introspect", config.issuer),
    {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`, "utf8").toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ token: accessToken, token_type_hint: "access_token" }),
    },
  );
  if (!response.ok) return null;
  const body = (await response.json()) as {
    active?: boolean;
    sub?: string;
    client_id?: string;
    scope?: string;
  };
  if (
    body.active !== true ||
    body.client_id !== (process.env.CERTUS_CLI_CLIENT_ID ?? "conspectus-cli") ||
    !body.scope?.includes("usage:write") ||
    typeof body.sub !== "string"
  ) {
    return null;
  }
  introspectionCache.set(accessToken, { sub: body.sub, until: Date.now() + CACHE_TTL_MS });
  return body.sub;
}

/** Local JWT verification fallback for collector-issued tokens (not used in M4). */
export async function verifyJwtForTests(
  token: string,
  issuer: string,
): Promise<{ sub?: string } | null> {
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(new URL(issuer).href.replace(/\/$/, "") + "/oauth2/jwks"));
  }
  try {
    const result = await jwtVerify(token, jwks, { issuer });
    return result.payload;
  } catch {
    return null;
  }
}
