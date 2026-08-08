import { lookup } from "node:dns/promises";
import { request as httpRequest, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, type IPVersion, type LookupFunction, type Socket } from "node:net";

type LookupAddress = { address: string; family: number };
type WebhookResolver = (hostname: string) => Promise<LookupAddress[]>;

export type ResolvedWebhookTarget = {
  url: URL;
  hostname: string;
  address: string;
  family: 4 | 6;
};

export type SafeWebhookPost = {
  body: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
};

// Keep the families separate: Node's BlockList intentionally treats IPv4 as
// IPv4-mapped IPv6, so adding ::ffff:0:0/96 to a shared list would block every
// ordinary IPv4 address as well.
const BLOCKED_IPV4 = new BlockList();
const BLOCKED_IPV6 = new BlockList();

for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  BLOCKED_IPV4.addSubnet(network, prefix, "ipv4");
}

for (const [network, prefix] of [
  ["::", 96],
  ["::ffff:0:0", 96],
  ["64:ff9b::", 96],
  ["100::", 64],
  ["2001::", 32],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const) {
  BLOCKED_IPV6.addSubnet(network, prefix, "ipv6");
}

const defaultResolver: WebhookResolver = async (hostname) =>
  lookup(hostname, { all: true, verbatim: true });

function withoutIpv6Brackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

function ipVersion(family: 4 | 6): IPVersion {
  return family === 4 ? "ipv4" : "ipv6";
}

/** Fail closed for every non-IP, private, loopback, link-local or special-use address. */
export function isBlockedWebhookAddress(address: string): boolean {
  if (address.includes("%")) return true;
  const family = isIP(address);
  if (family !== 4 && family !== 6) return true;
  const blockList = family === 4 ? BLOCKED_IPV4 : BLOCKED_IPV6;
  return blockList.check(address, ipVersion(family));
}

export function matchesResolvedAddress(expected: string, actual: string): boolean {
  if (actual.includes("%")) return false;
  const expectedFamily = isIP(expected);
  const actualFamily = isIP(actual);
  if ((expectedFamily !== 4 && expectedFamily !== 6) || expectedFamily !== actualFamily) {
    return false;
  }

  const exactAddress = new BlockList();
  exactAddress.addAddress(expected, ipVersion(expectedFamily));
  return exactAddress.check(actual, ipVersion(expectedFamily));
}

/**
 * Resolve once and reject the entire target if any returned address is unsafe.
 * Rejecting mixed public/private answers prevents the connector from choosing a
 * different record than the validator inspected.
 */
export async function resolveWebhookTarget(
  rawUrl: string,
  resolver: WebhookResolver = defaultResolver,
): Promise<ResolvedWebhookTarget | null> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== ""
  ) {
    return null;
  }

  const hostname = withoutIpv6Brackets(url.hostname);
  const normalizedHostname = hostname.toLowerCase().replace(/\.$/, "");
  if (normalizedHostname === "localhost" || normalizedHostname.endsWith(".localhost")) {
    return null;
  }
  const literalFamily = isIP(hostname);
  let addresses: LookupAddress[];
  try {
    addresses = literalFamily
      ? [{ address: hostname, family: literalFamily }]
      : await resolver(hostname);
  } catch {
    return null;
  }

  if (addresses.length === 0) return null;
  for (const candidate of addresses) {
    const family = isIP(candidate.address);
    if (
      (family !== 4 && family !== 6) ||
      candidate.family !== family ||
      isBlockedWebhookAddress(candidate.address)
    ) {
      return null;
    }
  }

  const selected = addresses[0];
  return {
    url,
    hostname,
    address: selected.address,
    family: selected.family as 4 | 6,
  };
}

/** Node's connector receives only the address that passed validation. */
export function createPinnedLookup(target: ResolvedWebhookTarget): LookupFunction {
  return (hostname, options, callback) => {
    if (hostname !== target.hostname) {
      const error = new Error("webhook hostname changed") as NodeJS.ErrnoException;
      error.code = "ENOTFOUND";
      callback(error, "", target.family);
      return;
    }

    if (options.all) {
      callback(null, [{ address: target.address, family: target.family }]);
      return;
    }
    callback(null, target.address, target.family);
  };
}

function sendPinnedWebhook(
  target: ResolvedWebhookTarget,
  { body, headers = {}, timeoutMs = 10_000 }: SafeWebhookPost,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const requestOptions: RequestOptions = {
      agent: false,
      family: target.family,
      headers: {
        ...headers,
        "content-length": Buffer.byteLength(body).toString(),
      },
      hostname: target.hostname,
      lookup: createPinnedLookup(target),
      method: "POST",
      path: `${target.url.pathname}${target.url.search}`,
      port: target.url.port || undefined,
      protocol: target.url.protocol,
      signal: AbortSignal.timeout(timeoutMs),
      timeout: timeoutMs,
    };

    const transport = target.url.protocol === "https:" ? httpsRequest : httpRequest;
    const request = transport(requestOptions, (response) => {
      const ok = response.statusCode !== undefined && response.statusCode >= 200 && response.statusCode < 300;
      response.resume();
      response.once("end", () => finish(ok));
      response.once("error", () => finish(false));
    });

    request.once("socket", (socket) => {
      const connectedEvent = target.url.protocol === "https:" ? "secureConnect" : "connect";
      socket.once(connectedEvent, () => {
        const remoteAddress = (socket as Socket).remoteAddress;
        if (
          !remoteAddress ||
          isBlockedWebhookAddress(remoteAddress) ||
          !matchesResolvedAddress(target.address, remoteAddress)
        ) {
          request.destroy(new Error("webhook remote address did not match validated address"));
        }
      });
    });
    request.once("timeout", () => request.destroy(new Error("webhook request timed out")));
    request.once("error", () => finish(false));
    request.end(body);
  });
}

/** Resolve, validate and POST through the same pinned connection path. Redirects are never followed. */
export async function postSafeWebhook(rawUrl: string, post: SafeWebhookPost): Promise<boolean> {
  const target = await resolveWebhookTarget(rawUrl);
  if (!target) return false;
  return sendPinnedWebhook(target, post);
}
