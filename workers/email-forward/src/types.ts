/**
 * Cloudflare Email Routing 运行时类型的最小声明（#59）。
 *
 * 刻意不引 @cloudflare/workers-types：本包只用到 EmailMessage 的五个成员，
 * 自声明可以避免整套 workers-types 依赖；与官方 ForwardableEmailMessage
 * 的对应字段保持一致（见 docs/runbook.md 邮件入站一节引用的文档）。
 */

export interface InboundEmailMessage {
  /** envelope MAIL FROM */
  readonly from: string;
  /** envelope RCPT TO（用户专属别名地址） */
  readonly to: string;
  /** RFC 822 头（Subject、Message-ID 等） */
  readonly headers: Headers;
  /** raw MIME 字节流 */
  readonly raw: ReadableStream<Uint8Array>;
  /** raw 完整大小（字节），读流前即可用于超限判断 */
  readonly rawSize: number;
  /** 永久拒信（SMTP bounce）；本 Worker 不用——失败一律抛错交平台重试 */
  setReject(reason: string): void;
}

/** Worker 环境绑定：secret 通过 wrangler secret 注入，站点基址走 [vars]。 */
export interface InboundWorkerEnv {
  INBOUND_WEBHOOK_SECRET?: string;
  INBOUND_ENDPOINT?: string;
}
