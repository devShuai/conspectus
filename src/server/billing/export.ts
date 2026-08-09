import { db } from "@/server/db";
import { csvLine } from "./csv";

/**
 * CSV 导出数据源（design §7.7）：async generator 逐页产出 CSV 行，
 * 路由层把它包成 ReadableStream 即可流式下发，全量数据不进内存。
 * 分页用 id 作 keyset cursor（createdAt 非唯一，加 id 决胜保证不漏不重）。
 */

const PAGE_SIZE = 500;

/** 订阅列集与 §7.7 对齐 —— 导入（三步走）按同一份列定义解析，保证 round-trip。 */
export const SUBSCRIPTION_CSV_COLUMNS = [
  "name",
  "vendor",
  "plan",
  "price",
  "currency",
  "billing_cycle",
  "cycle_days",
  "started_at",
  "anchor_day",
  "status",
  "auto_renew",
  "category",
  "payment_method",
  "tags",
  "notes",
] as const;

const BILLING_CSV_COLUMNS = [
  "id",
  "subscription_id",
  "record_type",
  "amount",
  "currency",
  "billed_at",
  "status",
  "source",
  "occurrence_key",
] as const;

function dateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export async function* subscriptionCsvChunks(userId: string): AsyncGenerator<string> {
  yield csvLine(SUBSCRIPTION_CSV_COLUMNS);
  let cursor: string | undefined;
  for (;;) {
    const rows = await db.subscription.findMany({
      where: { userId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: PAGE_SIZE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      include: {
        vendor: { select: { name: true, category: true } },
        paymentMethod: { select: { label: true } },
      },
    });
    if (rows.length === 0) return;
    for (const row of rows) {
      yield csvLine([
        row.name,
        row.vendor?.name ?? "",
        row.planName ?? "",
        row.price.toString(),
        row.currency,
        row.billingCycle,
        row.cycleDays ?? "",
        dateOnly(row.startedAt),
        row.anchorDay ?? "",
        row.status,
        row.autoRenew,
        row.vendor?.category ?? "",
        row.paymentMethod?.label ?? "",
        row.tags.join(";"),
        row.notes ?? "",
      ]);
    }
    cursor = rows[rows.length - 1].id;
    if (rows.length < PAGE_SIZE) return;
  }
}

export async function* billingCsvChunks(userId: string): AsyncGenerator<string> {
  yield csvLine(BILLING_CSV_COLUMNS);
  let cursor: string | undefined;
  for (;;) {
    const rows = await db.billingRecord.findMany({
      where: { userId },
      orderBy: [{ billedAt: "asc" }, { id: "asc" }],
      take: PAGE_SIZE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    if (rows.length === 0) return;
    for (const row of rows) {
      yield csvLine([
        row.id,
        row.subscriptionId,
        row.recordType,
        row.amount.toString(),
        row.currency,
        dateOnly(row.billedAt),
        row.status,
        row.source,
        row.occurrenceKey ?? "",
      ]);
    }
    cursor = rows[rows.length - 1].id;
    if (rows.length < PAGE_SIZE) return;
  }
}
