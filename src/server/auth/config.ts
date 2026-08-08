export interface AuthConfig {
  appUrl: URL;
  callbackUrl: URL;
  issuer: URL;
  issuerIdentifier: string;
  clientId: string;
  clientSecret: string;
  authSecret: string;
  secureCookies: boolean;
}

type AuthEnvironment = Record<string, string | undefined>;

export function loadAuthConfig(environment: AuthEnvironment = process.env): AuthConfig {
  const appUrl = loadAppUrl(environment);
  const production = environment.NODE_ENV === "production";
  const issuer = requiredURL("CERTUS_ISSUER", environment.CERTUS_ISSUER, production);
  const clientId = requiredValue("CERTUS_CLIENT_ID", environment.CERTUS_CLIENT_ID);
  const clientSecret = requiredValue("CERTUS_CLIENT_SECRET", environment.CERTUS_CLIENT_SECRET);
  const authSecret = requiredValue("AUTH_SECRET", environment.AUTH_SECRET);

  if (Buffer.byteLength(authSecret, "utf8") < 32) {
    throw new Error("AUTH_SECRET must be at least 32 bytes");
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
    authSecret,
    secureCookies: appUrl.protocol === "https:",
  };
}

/** APP_URL is shared by certus and local auth, so loading it must not require certus config. */
export function loadAppUrl(environment: AuthEnvironment = process.env): URL {
  const appUrl = requiredURL(
    "APP_URL",
    environment.APP_URL,
    environment.NODE_ENV === "production",
  );
  if (appUrl.pathname !== "/" || appUrl.search || appUrl.hash) {
    throw new Error("APP_URL must be an origin without a path, query, or fragment");
  }
  return appUrl;
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
