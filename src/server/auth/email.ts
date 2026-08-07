import { domainToASCII } from "node:url";

/**
 * Normalize an email for local-account identity (design.md §6.2):
 * trim → lowercase → IDNA-ASCII the domain → lowercase again.
 * Throws on malformed addresses.
 */
export function normalizeEmail(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 320) {
    throw new Error("invalid email");
  }
  const at = trimmed.lastIndexOf("@");
  if (at <= 0 || at === trimmed.length - 1) {
    throw new Error("invalid email");
  }
  if (trimmed.includes(" ") || trimmed.includes("\t")) {
    throw new Error("invalid email");
  }
  const local = trimmed.slice(0, at).toLowerCase();
  const domainRaw = trimmed.slice(at + 1).toLowerCase();
  let domain: string;
  try {
    domain = domainToASCII(domainRaw);
  } catch {
    throw new Error("invalid email domain");
  }
  if (!domain || !domain.includes(".")) {
    throw new Error("invalid email domain");
  }
  return `${local}@${domain}`;
}
