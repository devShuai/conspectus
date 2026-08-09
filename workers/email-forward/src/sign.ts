/**
 * 入站 webhook 签名（#59，Worker 侧）。
 *
 * 契约与 src/server/import/inbound.ts 逐字节对齐（design §6.2 canonical 形式）：
 *   canonical = "POST" + "\n" + "/api/inbound/email" + "\n" + timestamp + "\n" + sha256hex(body)
 *   signature = HMAC-SHA256 hex(secret, canonical)
 * 任何格式漂移都会被 src/fixtures/signature-vectors.json 的双端对拍测试拦住
 * （sign.test.ts 验 Worker 侧，server-parity.test.ts 验服务端侧）。
 *
 * Worker 运行时没有 node:crypto，一律走 WebCrypto（crypto.subtle）。
 */

export const INBOUND_PATH = "/api/inbound/email";

function toHex(buffer: ArrayBuffer): string {
  let out = "";
  for (const byte of new Uint8Array(buffer)) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}

export async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
}

export async function sha256HexText(text: string): Promise<string> {
  return sha256HexBytes(new TextEncoder().encode(text));
}

/** 与服务端 inboundSignatureMessage 同构；bodyText 是线上发送的原始请求体字符串。 */
export async function inboundSignatureMessage(
  timestamp: string,
  bodyText: string,
): Promise<string> {
  const bodyHash = await sha256HexText(bodyText);
  return ["POST", INBOUND_PATH, timestamp, bodyHash].join("\n");
}

/** 与服务端 signInboundRequest 同构：HMAC-SHA256 hex，密钥即共享 secret 的 UTF-8。 */
export async function signInboundRequest(
  secret: string,
  timestamp: string,
  bodyText: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const message = await inboundSignatureMessage(timestamp, bodyText);
  return toHex(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)),
  );
}
