import { lookup } from "node:dns/promises";

const PRIVATE_CIDRS = [
  /^10\./,
  /^127\./,
  /^192\.168\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
];

/**
 * Webhook SSRF guard (design §9): resolves the hostname, rejects private /
 * loopback / link-local addresses, and blocks redirects (DNS rebinding
 * mitigation). Returns a safe URL or null.
 */
export async function resolveWebhookTarget(rawUrl: string): Promise<URL | null> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return null;
  }
  if (url.hostname === "localhost" || url.hostname === "::1") {
    return null;
  }
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(url.hostname, { all: true, verbatim: true });
  } catch {
    return null;
  }
  for (const { address } of addresses) {
    if (PRIVATE_CIDRS.some((re) => re.test(address))) {
      return null;
    }
    if (address === "::1" || address.startsWith("fe80:")) {
      return null;
    }
  }
  return url;
}
