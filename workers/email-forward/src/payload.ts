/**
 * 把 EmailMessage 变成 /api/inbound/email 的请求体（#59）。
 *
 * 字段口径与服务端 inboundEmailPayloadSchema（src/server/import/inbound.ts）对齐：
 * messageId ≤200、from/to ≤320、subject ≤500、raw 为 base64。
 *
 * 大小纪律：服务端请求体上限 1 MiB，base64 膨胀约 4/3，raw 截断到
 * RAW_MAX_BYTES = 700 KiB 后整个 JSON body 仍稳在 1 MiB 以内（design §7.5
 * 「worker 侧按大小上限截断」——截断保留通常排在 MIME 前面的纯文本部分，
 * 超限的一般是附件）。截断是确定性的，重试重放得到同一份 payload。
 */

import { sha256HexBytes } from "./sign";
import type { InboundEmailMessage } from "./types";

export const RAW_MAX_BYTES = 700 * 1024;

/** 与服务端 InboundEmailPayload 同形；strict schema 不允许任何额外字段。 */
export interface InboundPayload {
  messageId: string;
  from: string;
  to: string;
  subject: string;
  receivedAt: string;
  raw?: string;
}

export interface BuiltInbound {
  payload: InboundPayload;
  /** raw 因超过上限被截断（仅大小事实，不含内容） */
  truncated: boolean;
  /** 实际读入的 raw 字节数（截断后） */
  rawBytes: number;
}

/** 读 raw 流，至多 limit 字节；超限即 cancel 剩余流并标记 truncated。 */
export async function readRawWithLimit(
  raw: ReadableStream<Uint8Array>,
  limit: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const reader = raw.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      let chunk = value;
      if (total + chunk.length > limit) {
        chunk = chunk.subarray(0, limit - total);
        truncated = true;
      }
      chunks.push(chunk);
      total += chunk.length;
      if (truncated) {
        await reader.cancel();
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return { bytes, truncated };
}

/** workerd/Node 都没有分片友好的 base64；32 KiB 分片避免展开参数爆栈。 */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * 组 payload。messageId 取 Message-ID 头；缺失时用 raw 内容哈希兜底——
 * 重试（平台级重投）重放的是同一封邮件，两种来源都稳定，服务端按
 * (userId, messageId) 唯一约束幂等去重，不产生重复草稿。
 */
export async function buildPayload(
  message: Pick<InboundEmailMessage, "from" | "to" | "headers" | "raw">,
  options: { rawMaxBytes?: number; now?: Date } = {},
): Promise<BuiltInbound> {
  const { bytes, truncated } = await readRawWithLimit(
    message.raw,
    options.rawMaxBytes ?? RAW_MAX_BYTES,
  );
  const headerId = (message.headers.get("message-id") ?? "").trim();
  const messageId = (
    headerId || `raw-sha256-${await sha256HexBytes(bytes)}`
  ).slice(0, 200);
  return {
    payload: {
      messageId,
      from: message.from.slice(0, 320),
      to: message.to.slice(0, 320),
      subject: (message.headers.get("subject") ?? "").slice(0, 500),
      receivedAt: (options.now ?? new Date()).toISOString(),
      raw: bytesToBase64(bytes),
    },
    truncated,
    rawBytes: bytes.length,
  };
}
