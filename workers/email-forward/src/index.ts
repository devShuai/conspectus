/**
 * Cloudflare Email Worker 入口（#59，design §7.5）：收信 → HMAC 签名 →
 * POST 到 conspectus /api/inbound/email。契约见 src/server/import/inbound.ts 头注。
 *
 * 失败策略：
 * - 202 之外的一切响应（含 401/429/5xx/404）与网络/超时错误一律抛错，
 *   交给 Email Routing 的平台重试。重试重放同一封邮件，messageId 稳定
 *   （Message-ID 头或 raw 哈希），服务端 (userId, messageId) 幂等，不产生
 *   重复行。401 也走重试而非丢弃：secret 轮换窗口内两侧短暂不一致，重试
 *   可在轮换完成后自愈（轮换顺序见 docs/runbook.md）。
 * - 不 setReject：瞬时故障弹回给用户的转发邮箱只会造成困惑。
 *
 * 日志纪律（design §9，issue 验收）：只写事件名、状态码、字节数；绝不写
 * 收件/发件地址、主题、正文或 secret。
 */

import { buildPayload } from "./payload";
import { INBOUND_PATH, signInboundRequest } from "./sign";
import type { InboundEmailMessage, InboundWorkerEnv } from "./types";

/** 本站 webhook 单次转发超时；超时按瞬时故障处理（抛错重试）。 */
export const FETCH_TIMEOUT_MS = 10_000;

function audit(event: string, extra: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event, ...extra }));
}

export async function handleEmail(
  message: InboundEmailMessage,
  env: InboundWorkerEnv,
): Promise<void> {
  const secret = env.INBOUND_WEBHOOK_SECRET?.trim();
  const endpoint = env.INBOUND_ENDPOINT?.trim().replace(/\/+$/, "");
  if (!secret || !endpoint) {
    // 配置缺失/未启用：抛错让平台重试，配置补齐后投递自愈
    throw new Error("inbound forward not configured");
  }

  const built = await buildPayload(message);
  const bodyText = JSON.stringify(built.payload);
  const timestamp = String(Date.now());
  const signature = await signInboundRequest(secret, timestamp, bodyText);

  let response: Response;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    response = await fetch(`${endpoint}${INBOUND_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-inbound-timestamp": timestamp,
        "x-inbound-signature": signature,
      },
      body: bodyText,
      signal: controller.signal,
    });
  } catch {
    clearTimeout(timer);
    audit("inbound_forward_retry", { cause: "fetch_failed" });
    throw new Error("inbound upstream unreachable");
  }
  clearTimeout(timer);

  if (response.status === 202) {
    audit("inbound_forwarded", {
      truncated: built.truncated,
      rawBytes: built.rawBytes,
    });
    return;
  }
  audit("inbound_forward_retry", { status: response.status });
  throw new Error(`inbound upstream status ${response.status}`);
}

export default {
  async email(
    message: InboundEmailMessage,
    env: InboundWorkerEnv,
  ): Promise<void> {
    await handleEmail(message, env);
  },
};
