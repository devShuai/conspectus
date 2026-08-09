import { z } from "zod";

/**
 * ImportDraft.payload 的版本化 Zod schema（#57，design §7.5）。
 *
 * 草稿是解析层（#60）与用户确认（#61）之间唯一的传递载体，因此：
 * - 显式 version 字段：规则演进只新增版本，不回改既有草稿 payload（#60 验收）；
 * - 所有对象 strict：拒绝任何未声明字段，payload 不可能夹带任意 HTML/脚本；
 * - 金额用十进制字符串，绝不经过浮点（与 BillingRecord numeric(14,2) 对齐）；
 * - 字符串只有长度上限的纯文本语义，UI 一律按文本渲染，不当 HTML 注入。
 */

export const IMPORT_DRAFT_PAYLOAD_VERSION = 1;

const BILLING_CYCLES = [
  "weekly",
  "monthly",
  "quarterly",
  "yearly",
  "custom",
  "lifetime",
  "one_time",
] as const;

export const importDraftPayloadV1Schema = z
  .object({
    version: z.literal(IMPORT_DRAFT_PAYLOAD_VERSION),
    candidate: z
      .object({
        vendorSlug: z.string().min(1).max(64).optional(),
        name: z.string().min(1).max(200),
        planName: z.string().max(200).optional(),
        amount: z.string().regex(/^\d+(\.\d{1,2})?$/, "金额需为十进制字符串"),
        currency: z.string().regex(/^[A-Z]{3}$/, "币种需为 3 位 ISO-4217 代码"),
        billedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "扣费日需为 YYYY-MM-DD"),
        billingCycle: z.enum(BILLING_CYCLES).optional(),
        reference: z.string().max(200).optional(),
      })
      .strict(),
    evidence: z
      .object({
        sourceMessageId: z.string().max(200).optional(),
        fromAddr: z.string().max(320).optional(),
        subject: z.string().max(500).optional(),
        matchedRule: z.string().max(100).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type ImportDraftPayloadV1 = z.infer<typeof importDraftPayloadV1Schema>;

export const importDraftPayloadSchema = importDraftPayloadV1Schema;

/** 写入 ImportDraft.payload 前的统一入口；不合法 payload 直接拒绝落库。 */
export function parseImportDraftPayload(input: unknown): ImportDraftPayloadV1 {
  return importDraftPayloadSchema.parse(input);
}
