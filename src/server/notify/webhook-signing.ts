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
): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-conspectus-event-id": eventId,
  };
  if (secretCipher) {
    const secret = decryptCredential(secretCipher, loadCredentialKeyring());
    headers["x-conspectus-signature"] = createHmac("sha256", secret)
      .update(body)
      .digest("hex");
  }
  return headers;
}
