import { db } from "@/server/db";
import { prepareFxForPayment, recordPaidCharge } from "@/server/billing/billing";
import {
  createSubscription,
  type TenantUserId,
} from "@/server/billing/subscriptions";

import {
  parseImportDraftPayload,
  type ImportDraftPayloadV1,
} from "./draft-payload";
import { suggestSubscription } from "./parse";

/**
 * Inbox 草稿服务层（#61，design §7.5 解析管线 I→J 步）。
 *
 * 底线：
 * - 草稿一律用户确认后才入账；pending 草稿绝不出现在 BillingRecord 与实付统计；
 * - 状态迁移全部 CAS（status=pending 且未过期才允许），并发双击/重复提交只有
 *   一个调用成功，绝不产生第二笔 BillingRecord；
 * - acceptDraft 与手工入账走完全相同的 recordPaidCharge 汇率/投影路径（§7.5
 *   「确认即入账」，不另开换算分支）；汇率就绪在事务/用户锁之外完成（§7.3、
 *   #106/#108）；
 * - 所有查询以会话 userId 为租户边界，跨租户一律 not_found，不泄露存在性。
 *
 * reauth 判定（design §7.1/§8）：敏感操作重认证清单是「导出全部数据、注销
 * 账号、查看/轮换 Webhook 密钥」；acceptDraft 不在其中 —— 草稿页本身就是一次
 * 显式人工确认，§8 也把 acceptDraft/rejectDraft 列为普通 Server Actions。
 */

export class DraftError extends Error {
  constructor(
    public readonly code: "not_found" | "conflict" | "expired" | "invalid_input",
    message: string,
  ) {
    super(message);
    this.name = "DraftError";
  }
}

type DraftStateRow = { status: string; expiresAt: Date };

/** pending 且未过期才可操作；过期 pending（purge 尚未翻到 expired）同样拒绝。 */
function assertActionable(draft: DraftStateRow, now: Date): void {
  if (draft.status !== "pending") {
    throw new DraftError("conflict", "草稿已处理，请刷新页面");
  }
  if (draft.expiresAt.getTime() <= now.getTime()) {
    throw new DraftError("expired", "草稿已过期，无法接受或编辑");
  }
}

/* ---------------- Inbox 列表 ---------------- */

export interface InboxDraftItem {
  id: string;
  payload: ImportDraftPayloadV1;
  confidence: number;
  createdAt: Date;
  expiresAt: Date;
  /** 来源邮件的收件时间（evidence.sourceMessageId → InboundEmail）；缺失为 null。 */
  sourceReceivedAt: Date | null;
  suggestedSubscriptionId: string | null;
  suggestedSubscriptionName: string | null;
}

/** 当前用户的 pending 草稿（§7.5：Inbox 只显示待确认）。 */
export async function listInboxDrafts(userId: TenantUserId): Promise<InboxDraftItem[]> {
  const rows = await db.importDraft.findMany({
    where: { userId, status: "pending" },
    orderBy: { createdAt: "desc" },
  });
  if (rows.length === 0) return [];

  const items = rows.map((row) => ({
    row,
    payload: parseImportDraftPayload(row.payload),
  }));

  // 来源邮件收件时间：payload.evidence.sourceMessageId（#61 起由解析接线注入）
  const messageIds = [
    ...new Set(
      items
        .map((i) => i.payload.evidence?.sourceMessageId)
        .filter((v): v is string => typeof v === "string" && v !== ""),
    ),
  ];
  const sourceRows = messageIds.length
    ? await db.inboundEmail.findMany({
        where: { userId, messageId: { in: messageIds } },
        select: { messageId: true, receivedAt: true },
      })
    : [];
  const receivedAtByMessageId = new Map(sourceRows.map((r) => [r.messageId, r.receivedAt]));

  const suggestedIds = [
    ...new Set(
      items
        .map((i) => i.row.suggestedSubscriptionId)
        .filter((v): v is string => v !== null),
    ),
  ];
  const suggestedRows = suggestedIds.length
    ? await db.subscription.findMany({
        where: { userId, id: { in: suggestedIds } },
        select: { id: true, name: true },
      })
    : [];
  const suggestedNameById = new Map(suggestedRows.map((s) => [s.id, s.name]));

  return items.map(({ row, payload }) => ({
    id: row.id,
    payload,
    confidence: Number(row.confidence),
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    sourceReceivedAt: payload.evidence?.sourceMessageId
      ? (receivedAtByMessageId.get(payload.evidence.sourceMessageId) ?? null)
      : null,
    suggestedSubscriptionId: row.suggestedSubscriptionId,
    suggestedSubscriptionName: row.suggestedSubscriptionId
      ? (suggestedNameById.get(row.suggestedSubscriptionId) ?? null)
      : null,
  }));
}

/* ---------------- 编辑 ---------------- */

export interface DraftCandidatePatch {
  name: string;
  planName?: string;
  amount: string;
  currency: string;
  billedAt: string;
  billingCycle?: ImportDraftPayloadV1["candidate"]["billingCycle"];
  reference?: string;
}

function parsePayloadOrInvalid(input: unknown): ImportDraftPayloadV1 {
  try {
    return parseImportDraftPayload(input);
  } catch {
    throw new DraftError("invalid_input", "草稿字段不合法");
  }
}

/**
 * 校正草稿字段（仅 pending 且未过期）。名称/金额/币种/周期任一变化都可能让
 * 既有订阅建议失效，保存时按 §7.5 的同一 suggestSubscription 规则重算。
 */
export async function updateDraftCandidate(
  userId: TenantUserId,
  draftId: string,
  patch: DraftCandidatePatch,
  now: Date = new Date(),
): Promise<{ suggestedSubscriptionId: string | null }> {
  const row = await db.importDraft.findFirst({ where: { id: draftId, userId } });
  if (!row) throw new DraftError("not_found", "草稿不存在");
  assertActionable(row, now);

  const existing = parsePayloadOrInvalid(row.payload);
  const candidate: ImportDraftPayloadV1["candidate"] = {
    name: patch.name,
    amount: patch.amount,
    currency: patch.currency,
    billedAt: patch.billedAt,
  };
  // vendorSlug 只能来自解析证据，UI 不提供修改（防止人为挂到错误 vendor）
  if (existing.candidate.vendorSlug) candidate.vendorSlug = existing.candidate.vendorSlug;
  if (patch.planName) candidate.planName = patch.planName;
  if (patch.billingCycle) candidate.billingCycle = patch.billingCycle;
  if (patch.reference) candidate.reference = patch.reference;

  const payload = parsePayloadOrInvalid({ ...existing, candidate });

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
  const suggestedSubscriptionId = suggestSubscription(candidate, subscriptions);

  const cas = await db.importDraft.updateMany({
    where: { id: row.id, userId, status: "pending", expiresAt: { gt: now } },
    data: { payload, suggestedSubscriptionId },
  });
  if (cas.count === 0) {
    const fresh = await db.importDraft.findFirst({ where: { id: row.id, userId } });
    if (!fresh) throw new DraftError("not_found", "草稿不存在");
    assertActionable(fresh, now);
    throw new DraftError("conflict", "草稿状态已变化，请刷新页面");
  }
  return { suggestedSubscriptionId };
}

/* ---------------- 接受 / 拒绝 ---------------- */

export interface AcceptDraftResult {
  subscriptionId: string;
  billingRecordId: string;
  createdSubscription: boolean;
  projected: boolean;
}

/**
 * 确认草稿并入账。单事务：CAS 占位（pending→accepted）→ 需要时建订阅 →
 * recordPaidCharge 写 BillingRecord(status=paid) + 投影。任一步失败整事务
 * 回滚，草稿回到 pending，可修正后重试。
 */
export async function acceptDraft(
  userId: TenantUserId,
  draftId: string,
  now: Date = new Date(),
): Promise<AcceptDraftResult> {
  const row = await db.importDraft.findFirst({ where: { id: draftId, userId } });
  if (!row) throw new DraftError("not_found", "草稿不存在");
  assertActionable(row, now);
  const preview = parsePayloadOrInvalid(row.payload);
  const previewBilledAt = new Date(`${preview.candidate.billedAt}T00:00:00.000Z`);

  // §7.3/#106/#108：汇率就绪在锁与事务之外（可能出网）；入账事务只读汇率表
  await prepareFxForPayment(userId, preview.candidate.currency, previewBilledAt, null);

  return db.$transaction(async (tx) => {
    // CAS 是唯一闸门：并发双击/重复提交只有一个事务占位成功，其余回滚（#61 验收）
    const cas = await tx.importDraft.updateMany({
      where: { id: row.id, userId, status: "pending", expiresAt: { gt: now } },
      data: { status: "accepted" },
    });
    if (cas.count === 0) {
      const fresh = await tx.importDraft.findFirst({ where: { id: row.id, userId } });
      if (!fresh) throw new DraftError("not_found", "草稿不存在");
      assertActionable(fresh, now);
      throw new DraftError("conflict", "草稿状态已变化，请刷新页面");
    }

    // CAS 后草稿对我们冻结（终态不可再编辑），以事务内读到的 payload 入账
    const locked = await tx.importDraft.findUniqueOrThrow({ where: { id: row.id } });
    const candidate = parsePayloadOrInvalid(locked.payload).candidate;
    const billedAt = new Date(`${candidate.billedAt}T00:00:00.000Z`);

    let subscriptionId = locked.suggestedSubscriptionId;
    let createdSubscription = false;
    if (subscriptionId) {
      const existing = await tx.subscription.findFirst({
        where: { id: subscriptionId, userId },
        select: { id: true },
      });
      // 建议目标已不存在（外键 SetNull 前的竞态窗口）：退化为新建订阅
      if (!existing) subscriptionId = null;
    }
    if (!subscriptionId) {
      const vendor = candidate.vendorSlug
        ? (await tx.vendor.findFirst({
            where: { userId, slug: candidate.vendorSlug },
            select: { id: true },
          })) ??
          (await tx.vendor.findFirst({
            where: { userId: null, slug: candidate.vendorSlug },
            select: { id: true },
          }))
        : null;
      const created = await createSubscription(
        userId,
        {
          name: candidate.name,
          planName: candidate.planName ?? null,
          status: "active",
          price: Number(candidate.amount),
          currency: candidate.currency,
          billingCycle: candidate.billingCycle ?? "monthly",
          startedAt: billedAt,
          vendorId: vendor?.id ?? null,
        },
        tx,
      );
      subscriptionId = created.id;
      createdSubscription = true;
    }

    // 与手工入账完全同一条路径（§7.5「确认即入账」）；(userId, externalRef)
    // 唯一约束是第二道幂等防线：一张草稿最多产生一笔 BillingRecord
    const charge = await recordPaidCharge(
      {
        userId,
        subscriptionId,
        amount: Number(candidate.amount),
        currency: candidate.currency,
        billedAt,
        source: "email",
        externalRef: `draft:${row.id}`,
      },
      tx,
    );
    return {
      subscriptionId,
      billingRecordId: charge.billingRecordId,
      createdSubscription,
      projected: charge.projected,
    };
  });
}

/** 拒绝草稿：CAS pending→rejected；已处理/过期/跨租户一律拒绝。 */
export async function rejectDraft(
  userId: TenantUserId,
  draftId: string,
  now: Date = new Date(),
): Promise<void> {
  const row = await db.importDraft.findFirst({ where: { id: draftId, userId } });
  if (!row) throw new DraftError("not_found", "草稿不存在");
  assertActionable(row, now);

  const cas = await db.importDraft.updateMany({
    where: { id: row.id, userId, status: "pending", expiresAt: { gt: now } },
    data: { status: "rejected" },
  });
  if (cas.count === 0) {
    const fresh = await db.importDraft.findFirst({ where: { id: row.id, userId } });
    if (!fresh) throw new DraftError("not_found", "草稿不存在");
    assertActionable(fresh, now);
    throw new DraftError("conflict", "草稿状态已变化，请刷新页面");
  }
}
