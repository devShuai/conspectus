export interface AuthConfig {
  appUrl: URL;
  callbackUrl: URL;
  issuer: URL;
  issuerIdentifier: string;
  clientId: string;
  clientSecret: string;
  secureCookies: boolean;
}

type AuthEnvironment = Record<string, string | undefined>;

export function loadAuthConfig(environment: AuthEnvironment = process.env): AuthConfig {
  const production = environment.NODE_ENV === "production";
  const appUrl = requiredURL("APP_URL", environment.APP_URL, production);
  const issuer = requiredURL("CERTUS_ISSUER", environment.CERTUS_ISSUER, production);
  const clientId = requiredValue("CERTUS_CLIENT_ID", environment.CERTUS_CLIENT_ID);
  const clientSecret = requiredValue("CERTUS_CLIENT_SECRET", environment.CERTUS_CLIENT_SECRET);

  if (appUrl.pathname !== "/" || appUrl.search || appUrl.hash) {
    throw new Error("APP_URL must be an origin without a path, query, or fragment");
  }
  if (issuer.search || issuer.hash) {
    throw new Error("CERTUS_ISSUER must not contain a query or fragment");
  }

  return {
    appUrl,
    callbackUrl: new URL("/api/auth/certus/callback", appUrl),
    issuer,
    issuerIdentifier: issuer.href.replace(/\/$/, ""),
    clientId,
    clientSecret,
    secureCookies: appUrl.protocol === "https:",
  };
}

function requiredValue(name: string, value: string | undefined): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new Error(`${name} is required`);
  }
  return normalized;
}

function requiredURL(name: string, value: string | undefined, production: boolean): URL {
  const raw = requiredValue(name, value);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${name} must be an absolute URL`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${name} must not contain credentials`);
  }
  if (parsed.protocol === "https:") {
    return parsed;
  }
  if (
    !production &&
    parsed.protocol === "http:" &&
    isLoopbackHostname(parsed.hostname)
  ) {
    return parsed;
  }
  throw new Error(`${name} must use HTTPS (HTTP is allowed only for loopback development)`);
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}
