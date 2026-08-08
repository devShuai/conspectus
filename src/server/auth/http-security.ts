import { isIP } from "node:net";

import { loadAppUrl } from "./config";
import { normalizeEmail } from "./email";

/** Require a browser-verifiable same-origin signal for public credential POSTs. */
export function isSameOriginAuthRequest(
  request: Request,
  appUrl: URL = loadAppUrl(),
): boolean {
  const origin = request.headers.get("origin");
  if (origin !== null) {
    try {
      const parsed = new URL(origin);
      return (
        parsed.origin === appUrl.origin &&
        parsed.pathname === "/" &&
        parsed.search === "" &&
        parsed.hash === "" &&
        parsed.username === "" &&
        parsed.password === ""
      );
    } catch {
      return false;
    }
  }

  const referer = request.headers.get("referer");
  if (referer === null) return false;
  try {
    return new URL(referer).origin === appUrl.origin;
  } catch {
    return false;
  }
}

/** Best available client address behind the supported HTTP proxies. */
export function clientIpFromRequest(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const realIp = request.headers.get("x-real-ip")?.trim();
  const candidate = forwarded || realIp;
  return candidate && isIP(candidate) !== 0 ? candidate.toLowerCase() : "unknown";
}

/** Keep malformed emails stable for rate limiting without storing the raw value. */
export function emailRateLimitKey(rawEmail: string): string {
  try {
    return normalizeEmail(rawEmail);
  } catch {
    return `invalid:${rawEmail.trim().toLowerCase().slice(0, 320) || "missing"}`;
  }
}

export function tokenRateLimitKey(rawToken: string): string {
  return rawToken.slice(0, 512) || "missing";
}
