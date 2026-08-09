import { db } from "@/server/db";
import {
  decryptCredential,
  type CredentialKeyring,
} from "@/server/auth/crypto";

import {
  parseImportDraftPayload,
} from "./draft-payload";
import {
  parseEmail,
  suggestSubscription,
  type ParseFailureReason,
} from "./parse";

/**
 * InboundEmail → ImportDraft 的解析接线（#60，design §7.5 解析管线 H 步）。
 *
 * - 触发点：/api/inbound/email 落库成功后（同事务之外、同一请求内顺序执行）；
 *   解析失败绝不让 webhook 返回非 202 —— 重投由 (userId, messageId) 唯一约束
 *   兜底，parseStatus=pending 的行可由后续补偿任务重试。
 * - parseStatus 流转：pending → parsed（草稿已建）| failed（可诊断失败）。
 *   CAS（updateMany where pending）保证并发/重入只处理一次、只建一条草稿。
 * - 失败可诊断：结构化日志只记 event/reason/rule id，绝不记主题/正文/地址
 *   （§9 日志脱敏），失败率指标按 reason + matchedRule 定位模板改版。
 * - 原文读取：rawCipher 按 keyring 解密（§9 envelope）；用户关闭保留时
 *   rawCipher 恒空，解析退化为仅主题（通常凑不齐必填字段 → failed）。
 */

/** 草稿确认窗口：与原文保留期同口径 30 天，过期由 purge 置 expired。 */
export const IMPORT_DRAFT_TTL_MS = 30 * 86_400_000;

export type ParseInboundResult =
  | { status: "parsed"; draftId: string; confidence: number; matchedRule: string | null }
  | { status: "failed"; reason: ParseFailureReason; matchedRule: string | null }
  | { status: "skipped" }; // 行不存在或已被处理（并发/重入幂等）

/** 结构化审计：只记事件/原因/规则 id，绝不记邮件内容或地址（§9）。 */
function auditParseFailed(reason: ParseFailureReason, matchedRule: string | null): void {
  console.log(
    JSON.stringify({
      event: "inbound_email_parse_failed",
      reason,
      rule: matchedRule,
      at: new Date().toISOString(),
    }),
  );
}

export async function parseInboundEmail(
  userId: string,
  messageId: string,
  keyring: CredentialKeyring,
  now: Date = new Date(),
): Promise<ParseInboundResult> {
  const row = await db.inboundEmail.findUnique({
    where: { userId_messageId: { userId, messageId } },
  });
  if (!row || row.parseStatus !== "pending") return { status: "skipped" };

  let raw: string | undefined;
  if (row.rawCipher) {
    try {
      raw = decryptCredential(row.rawCipher, keyring).toString("utf8");
    } catch {
      // 密钥已轮换出 keyring：原文永不可读，退化为仅主题解析
      raw = undefined;
    }
  }

  const outcome = parseEmail({
    fromAddr: row.fromAddr,
    subject: row.subject,
    receivedAt: row.receivedAt,
    raw,
  });

  if (!outcome.ok) {
    const cas = await db.inboundEmail.updateMany({
      where: { id: row.id, parseStatus: "pending" },
      data: { parseStatus: "failed" },
    });
    if (cas.count === 0) return { status: "skipped" };
    auditParseFailed(outcome.reason, outcome.matchedRule);
    return { status: "failed", reason: outcome.reason, matchedRule: outcome.matchedRule };
  }

  // 落库前再过一次版本化 schema：引擎产物与 ImportDraft.payload 的唯一闸门。
  // evidence.sourceMessageId 在此注入（#61 Inbox 据它关联来源邮件的收发时间）；
  // 引擎本身不感知 messageId 列。
  const payload = parseImportDraftPayload({
    ...outcome.payload,
    evidence: { ...(outcome.payload.evidence ?? {}), sourceMessageId: messageId },
  });

  const subscriptions = await db.subscription.findMany({
    where: { userId },
    select: {
      id: true,
      name: true,
      price: true,
      currency: true,
      billingCycle: true,
      vendor: { select: { name: true, slug: true } },
    },
  });
  const suggestedSubscriptionId = suggestSubscription(payload.candidate, subscriptions);

  // 同事务：CAS 占位 + 建草稿。CAS 失败 = 已被并发处理，草稿绝不多建
  const created = await db.$transaction(async (tx) => {
    const cas = await tx.inboundEmail.updateMany({
      where: { id: row.id, parseStatus: "pending" },
      data: { parseStatus: "parsed" },
    });
    if (cas.count === 0) return null;
    return tx.importDraft.create({
      data: {
        userId,
        source: "email",
        payload,
        confidence: outcome.confidence,
        suggestedSubscriptionId,
        expiresAt: new Date(now.getTime() + IMPORT_DRAFT_TTL_MS),
      },
    });
  });
  if (!created) return { status: "skipped" };
  return {
    status: "parsed",
    draftId: created.id,
    confidence: outcome.confidence,
    matchedRule: outcome.matchedRule,
  };
}
