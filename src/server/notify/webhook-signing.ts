import { createHmac } from "node:crypto";

import {
  decryptCredential,
  loadCredentialKeyring,
} from "@/server/auth/crypto";

/** Build stable webhook headers, decrypting the optional credential envelope first. */
export function webhookHeaders(
  eventId: string,
  body: string,
  secretCipher: Uint8Array | null,
  now: Date = new Date(),
): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-conspectus-event-id": eventId,
    // UTC 时间戳防重放（§7.6/§9 三件套：event id + timestamp + signature）
    "x-conspectus-timestamp": String(Math.floor(now.getTime() / 1000)),
  };
  if (secretCipher) {
    const secret = decryptCredential(secretCipher, loadCredentialKeyring());
    headers["x-conspectus-signature"] = createHmac("sha256", secret)
      .update(body)
      .digest("hex");
  }
  return headers;
}
