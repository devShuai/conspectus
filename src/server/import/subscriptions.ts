import type { BillingCycle, SubscriptionStatus, VendorCategory } from "@prisma/client";
import { z } from "zod";

import { db } from "@/server/db";
import { parseCsv } from "@/server/billing/csv";
import { deriveAnchorDay } from "@/server/billing/cycle";
import { SUBSCRIPTION_CSV_COLUMNS } from "@/server/billing/export";
import {
  TenantError,
  createSubscription,
  updateSubscription,
  type UpdateSubscriptionInput,
} from "@/server/billing/subscriptions";

/**
 * CSV 导入三步走的核心（design §7.7）：preview 逐行 Zod 校验并分类
 * 新建/冲突，confirm（execute）按冲突策略写入。列集与 #111 修正后的导出
 * 完全对齐，导出文件可直接 round-trip。
 *
 * 语义约定：
 * - 冲突按 (name, vendor) 大小写不敏感匹配；vendor 列缺省或为空按无 vendor 匹配；
 * - update 只覆盖 CSV 中出现的列：可空文本列（vendor/plan/payment_method/notes）
 *   出现但为空 = 清为 null，标量列（price/currency/…）为空 = 不覆盖；
 * - 幂等：同一 CSV 重复确认不产生重复行 —— skip/update 天然收敛，duplicate
 *   在「已存在与 CSV 完全一致的行」时跳过（首次确认创建的行正是完全一致行）；
 * - vendor 按名称解析不到时新建私有 Vendor（category 列即其分类，缺省 other）；
 *   payment_method 必须按 label 匹配已有支付方式（缺 kind 等信息，不自动新建）。
 */

export const CONFLICT_STRATEGIES = ["skip", "update", "duplicate"] as const;
export type ConflictStrategy = (typeof CONFLICT_STRATEGIES)[number];

/** 服务端处理上限：配合 UI 的 512KB 文件上限，约数千行。 */
export const MAX_IMPORT_ROWS = 2000;

export class ImportError extends Error {
  constructor(
    public readonly code: "missing_name_column" | "too_many_rows",
    message: string,
  ) {
    super(message);
    this.name = "ImportError";
  }
}

export interface ImportPreviewRow {
  /** 数据行号（表头之后第 N 条记录，从 1 起；引号内换行不多计）。 */
  row: number;
  name: string;
  vendor: string;
  action: ConflictStrategy | "create" | null; // null = 校验失败
  errors: string[];
  existingId: string | null;
  /** vendor 按名称未命中、confirm 时将新建私有 Vendor。 */
  willCreateVendor: boolean;
}

export interface ImportPreview {
  rows: ImportPreviewRow[];
  summary: {
    total: number;
    invalid: number;
    create: number;
    update: number;
    skip: number;
    duplicate: number;
  };
}

export interface ImportExecuteResult {
  created: number;
  updated: number;
  skipped: number;
  failed: { row: number; message: string }[];
}

const CYCLES = ["weekly", "monthly", "quarterly", "yearly", "custom", "lifetime", "one_time"] as const;
const STATUSES = ["trial", "active", "paused", "canceled", "expired"] as const;
const CATEGORIES = ["streaming", "ai", "cloud", "dev_tool", "storage", "domain", "music", "news", "game", "other"] as const;
const BOOL_VALUES = ["true", "false", "1", "0", "yes", "no"] as const;

function isIntIn(value: string, min: number, max: number): boolean {
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max;
}

function isDateOnly(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(new Date(`${value}T00:00:00Z`).getTime());
}

const trimmed = z.string().trim();
const rowSchema = z.object({
  name: trimmed.min(1, "name 不能为空").max(120, "name 过长"),
  vendor: trimmed.optional(),
  plan: trimmed.optional(),
  price: trimmed.refine(
    (v) => v === "" || (Number.isFinite(Number(v)) && Number(v) >= 0),
    "price 需为不小于 0 的数字",
  ).optional(),
  currency: trimmed.refine(
    (v) => v === "" || /^[A-Za-z]{3}$/.test(v),
    "currency 需为 3 位 ISO-4217 代码",
  ).optional(),
  billing_cycle: trimmed.refine(
    (v) => v === "" || (CYCLES as readonly string[]).includes(v),
    `billing_cycle 需为 ${CYCLES.join("/")} 之一`,
  ).optional(),
  cycle_days: trimmed.refine(
    (v) => v === "" || isIntIn(v, 1, 36600),
    "cycle_days 需为正整数",
  ).optional(),
  started_at: trimmed.refine(
    (v) => v === "" || isDateOnly(v),
    "started_at 需为 YYYY-MM-DD",
  ).optional(),
  anchor_day: trimmed.refine(
    (v) => v === "" || isIntIn(v, 1, 31),
    "anchor_day 需为 1-31 的整数",
  ).optional(),
  status: trimmed.refine(
    (v) => v === "" || (STATUSES as readonly string[]).includes(v),
    `status 需为 ${STATUSES.join("/")} 之一`,
  ).optional(),
  auto_renew: trimmed.refine(
    (v) => v === "" || (BOOL_VALUES as readonly string[]).includes(v.toLowerCase()),
    "auto_renew 需为 true/false",
  ).optional(),
  category: trimmed.refine(
    (v) => v === "" || (CATEGORIES as readonly string[]).includes(v),
    `category 需为 ${CATEGORIES.join("/")} 之一`,
  ).optional(),
  payment_method: trimmed.optional(),
  tags: z.string().optional(),
  notes: z.string().optional(),
});

/** 解析后的行；undefined = 列未出现（update 不覆盖），null = 出现但为空（清除）。 */
interface ParsedRow {
  present: ReadonlySet<string>;
  name: string;
  vendorName: string | null | undefined;
  planName: string | null | undefined;
  price: number | undefined;
  currency: string | undefined;
  billingCycle: BillingCycle | undefined;
  cycleDays: number | null | undefined;
  startedAt: Date | undefined;
  anchorDay: number | null | undefined;
  status: SubscriptionStatus | undefined;
  autoRenew: boolean | undefined;
  category: VendorCategory | undefined;
  paymentMethodName: string | null | undefined;
  tags: string[] | undefined;
  notes: string | null | undefined;
}

interface AnalyzedRow {
  row: number;
  display: { name: string; vendor: string };
  errors: string[];
  parsed: ParsedRow | null;
  conflictId: string | null;
  willCreateVendor: boolean;
}

interface UserContext {
  subscriptions: Array<{
    id: string;
    name: string;
    vendorId: string | null;
    planName: string | null;
    status: SubscriptionStatus;
    price: unknown;
    currency: string;
    billingCycle: BillingCycle;
    cycleDays: number | null;
    anchorDay: number | null;
    startedAt: Date;
    autoRenew: boolean;
    paymentMethodId: string | null;
    tags: string[];
    notes: string | null;
    vendor: { name: string } | null;
  }>;
  vendors: Array<{ id: string; userId: string | null; name: string }>;
  paymentMethods: Array<{ id: string; label: string }>;
}

async function loadContext(userId: string): Promise<UserContext> {
  const [subscriptions, vendors, paymentMethods] = await Promise.all([
    db.subscription.findMany({
      where: { userId },
      include: { vendor: { select: { name: true } } },
    }),
    db.vendor.findMany({
      where: { OR: [{ userId: null }, { userId }] },
      select: { id: true, userId: true, name: true },
    }),
    db.paymentMethod.findMany({
      where: { userId },
      select: { id: true, label: true },
    }),
  ]);
  return { subscriptions, vendors, paymentMethods };
}

function findVendorId(ctx: UserContext, userId: string, name: string): string | null {
  const lower = name.toLowerCase();
  const matches = ctx.vendors.filter((v) => v.name.toLowerCase() === lower);
  if (matches.length === 0) return null;
  // 同名时用户私有 Vendor 优先于系统目录
  return (matches.find((v) => v.userId === userId) ?? matches[0]).id;
}

function findPaymentMethodId(ctx: UserContext, label: string): string | null {
  const lower = label.toLowerCase();
  return ctx.paymentMethods.find((p) => p.label.toLowerCase() === lower)?.id ?? null;
}

function findConflict(ctx: UserContext, name: string, vendorName: string | null) {
  const lower = name.toLowerCase();
  const vendorLower = vendorName?.toLowerCase() ?? null;
  return (
    ctx.subscriptions.find(
      (s) =>
        s.name.toLowerCase() === lower &&
        (vendorLower === null
          ? s.vendorId === null
          : s.vendor?.name.toLowerCase() === vendorLower),
    ) ?? null
  );
}

function parseFields(raw: Record<string, string>): ParsedRow {
  const present = new Set(Object.keys(raw));
  const text = (key: string): string | null | undefined =>
    !present.has(key) ? undefined : raw[key] === "" ? null : raw[key];
  const scalar = (key: string): string | undefined =>
    !present.has(key) || raw[key] === "" ? undefined : raw[key];
  const bool = (v: string): boolean => v === "true" || v === "1" || v === "yes";
  return {
    present,
    name: raw.name,
    vendorName: text("vendor"),
    planName: text("plan"),
    price: scalar("price") !== undefined ? Number(raw.price) : undefined,
    currency: scalar("currency")?.toUpperCase(),
    billingCycle: scalar("billing_cycle") as BillingCycle | undefined,
    cycleDays: !present.has("cycle_days")
      ? undefined
      : raw.cycle_days === ""
        ? null
        : Number(raw.cycle_days),
    startedAt: scalar("started_at") !== undefined ? new Date(`${raw.started_at}T00:00:00Z`) : undefined,
    anchorDay: !present.has("anchor_day")
      ? undefined
      : raw.anchor_day === ""
        ? null
        : Number(raw.anchor_day),
    status: scalar("status") as SubscriptionStatus | undefined,
    autoRenew: scalar("auto_renew") !== undefined ? bool(raw.auto_renew.toLowerCase()) : undefined,
    category: scalar("category") as VendorCategory | undefined,
    paymentMethodName: text("payment_method"),
    tags: !present.has("tags")
      ? undefined
      : raw.tags === ""
        ? []
        : raw.tags.split(";").map((t) => t.trim()).filter(Boolean),
    notes: text("notes"),
  };
}

function analyze(ctx: UserContext, userId: string, text: string): AnalyzedRow[] {
  const records = parseCsv(text);
  const header = records[0]?.map((h) => h.trim().toLowerCase()) ?? [];
  const columnIndex = new Map<string, number>();
  for (const [index, name] of header.entries()) {
    if ((SUBSCRIPTION_CSV_COLUMNS as readonly string[]).includes(name) && !columnIndex.has(name)) {
      columnIndex.set(name, index);
    }
  }
  if (!columnIndex.has("name")) {
    throw new ImportError("missing_name_column", "CSV 缺少 name 列（首行需为表头）");
  }
  const dataRecords = records
    .slice(1)
    .map((fields, i) => ({ fields, row: i + 1 }))
    .filter(({ fields }) => fields.some((f) => f.trim() !== "")); // 空行跳过
  if (dataRecords.length > MAX_IMPORT_ROWS) {
    throw new ImportError("too_many_rows", `一次最多导入 ${MAX_IMPORT_ROWS} 行`);
  }

  return dataRecords.map(({ fields, row }) => {
    const raw: Record<string, string> = {};
    for (const [column, index] of columnIndex) raw[column] = fields[index] ?? "";
    const display = { name: raw.name ?? "", vendor: raw.vendor ?? "" };

    const validated = rowSchema.safeParse(raw);
    if (!validated.success) {
      return {
        row,
        display,
        errors: validated.error.issues.map(
          (issue) => `${String(issue.path[0] ?? "_")}: ${issue.message}`,
        ),
        parsed: null,
        conflictId: null,
        willCreateVendor: false,
      };
    }

    const parsed = parseFields(raw);
    const errors: string[] = [];

    // vendor：按名称命中已有（含系统目录）；未命中则 confirm 时新建私有 Vendor
    let willCreateVendor = false;
    if (parsed.vendorName) {
      const vendorId = findVendorId(ctx, userId, parsed.vendorName);
      willCreateVendor = vendorId === null;
    }
    // payment_method 不自动新建（缺 kind 等信息），必须命中
    if (parsed.paymentMethodName && findPaymentMethodId(ctx, parsed.paymentMethodName) === null) {
      errors.push(`payment_method 不存在：${parsed.paymentMethodName}`);
    }

    const conflict = findConflict(ctx, parsed.name, parsed.vendorName ?? null);

    const result: AnalyzedRow = {
      row,
      display,
      errors,
      parsed,
      conflictId: conflict?.id ?? null,
      willCreateVendor,
    };
    return result;
  });
}

/** create 侧必填校验：新建（含 duplicate 复制新建）才需要完整账期四要素。 */
function validateCreateRequirements(row: AnalyzedRow, strategy: ConflictStrategy): string[] {
  if (row.parsed === null) return row.errors;
  const willCreate = row.conflictId === null || strategy === "duplicate";
  if (!willCreate) return row.errors;
  const errors = [...row.errors];
  if (row.parsed.price === undefined) errors.push("新建缺少 price");
  if (row.parsed.currency === undefined) errors.push("新建缺少 currency");
  if (row.parsed.billingCycle === undefined) errors.push("新建缺少 billing_cycle");
  if (row.parsed.startedAt === undefined) errors.push("新建缺少 started_at");
  // CSV 列集没有 trial_ends_at（§7.7），trial 订阅只能走界面维护
  if (row.parsed.status === "trial") {
    errors.push("试用订阅无法经 CSV 导入（列集无 trial_ends_at）");
  }
  return errors;
}

function actionOf(row: AnalyzedRow, strategy: ConflictStrategy): ConflictStrategy | "create" {
  return row.conflictId === null ? "create" : strategy;
}

export async function previewSubscriptionImport(
  userId: string,
  csvText: string,
  strategy: ConflictStrategy,
): Promise<ImportPreview> {
  const ctx = await loadContext(userId);
  const analyzed = analyze(ctx, userId, csvText);

  const rows: ImportPreviewRow[] = [];
  const summary = { total: 0, invalid: 0, create: 0, update: 0, skip: 0, duplicate: 0 };
  for (const row of analyzed) {
    const errors = validateCreateRequirements(row, strategy);
    const action = errors.length > 0 ? null : actionOf(row, strategy);
    rows.push({
      row: row.row,
      name: row.display.name,
      vendor: row.display.vendor,
      action,
      errors,
      existingId: row.conflictId,
      willCreateVendor: row.willCreateVendor,
    });
    summary.total += 1;
    if (action === null) summary.invalid += 1;
    else summary[action] += 1;
  }
  return { rows, summary };
}

/** duplicate 策略的幂等锚：已存在行在 CSV 出现的每一列上都一致 = 这是重复确认。 */
function isExactMatch(
  parsed: ParsedRow,
  vendorId: string | null | undefined,
  paymentMethodId: string | null | undefined,
  existing: UserContext["subscriptions"][number],
): boolean {
  if (parsed.planName !== undefined && existing.planName !== parsed.planName) return false;
  if (parsed.price !== undefined && Number(existing.price) !== parsed.price) return false;
  if (parsed.currency !== undefined && existing.currency !== parsed.currency) return false;
  if (parsed.billingCycle !== undefined && existing.billingCycle !== parsed.billingCycle) return false;
  if (parsed.cycleDays !== undefined && existing.cycleDays !== parsed.cycleDays) return false;
  // anchor_day 出现但为空时，创建会按 §7.2 从 startedAt 推导；比较要拿推导后的有效值
  if (parsed.anchorDay !== undefined) {
    const effective =
      parsed.anchorDay ??
      deriveAnchorDay(
        parsed.billingCycle ?? existing.billingCycle,
        parsed.startedAt ?? existing.startedAt,
        null,
      );
    if (existing.anchorDay !== effective) return false;
  }
  if (parsed.startedAt !== undefined && existing.startedAt.getTime() !== parsed.startedAt.getTime()) return false;
  if (parsed.status !== undefined && existing.status !== parsed.status) return false;
  if (parsed.autoRenew !== undefined && existing.autoRenew !== parsed.autoRenew) return false;
  if (parsed.tags !== undefined && existing.tags.join(";") !== parsed.tags.join(";")) return false;
  if (parsed.notes !== undefined && existing.notes !== parsed.notes) return false;
  if (vendorId !== undefined && existing.vendorId !== vendorId) return false;
  if (paymentMethodId !== undefined && existing.paymentMethodId !== paymentMethodId) return false;
  return true;
}

function slugStemOf(name: string): string {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return (base.length >= 2 ? base : `v-${base || "import"}`).slice(0, 56);
}

async function createPrivateVendorForImport(
  userId: string,
  name: string,
  category: VendorCategory,
): Promise<{ id: string; name: string }> {
  const stem = slugStemOf(name);
  for (let attempt = 0; ; attempt += 1) {
    const slug = attempt === 0 ? stem : `${stem}-${attempt + 1}`;
    const conflict = await db.vendor.findFirst({ where: { userId, slug }, select: { id: true } });
    if (conflict) continue;
    const created = await db.vendor.create({
      data: { slug, name: name.trim(), category, userId },
      select: { id: true, name: true },
    });
    return created;
  }
}

/** 解析 vendor 列：undefined 不动，null 清除，名称命中或新建私有 Vendor。 */
async function resolveVendorId(
  ctx: UserContext,
  userId: string,
  parsed: ParsedRow,
): Promise<string | null | undefined> {
  if (parsed.vendorName === undefined) return undefined;
  if (parsed.vendorName === null) return null;
  const found = findVendorId(ctx, userId, parsed.vendorName);
  if (found !== null) return found;
  const created = await createPrivateVendorForImport(
    userId,
    parsed.vendorName,
    parsed.category ?? "other",
  );
  ctx.vendors.push({ id: created.id, userId, name: created.name });
  return created.id;
}

function resolvePaymentMethodId(
  ctx: UserContext,
  parsed: ParsedRow,
): string | null | undefined {
  if (parsed.paymentMethodName === undefined) return undefined;
  if (parsed.paymentMethodName === null) return null;
  return findPaymentMethodId(ctx, parsed.paymentMethodName);
}

function toUpdateInput(parsed: ParsedRow, vendorId: string | null | undefined): UpdateSubscriptionInput {
  const input: UpdateSubscriptionInput = { name: parsed.name };
  if (parsed.planName !== undefined) input.planName = parsed.planName;
  if (parsed.price !== undefined) input.price = parsed.price;
  if (parsed.currency !== undefined) input.currency = parsed.currency;
  if (parsed.billingCycle !== undefined) input.billingCycle = parsed.billingCycle;
  if (parsed.cycleDays !== undefined) input.cycleDays = parsed.cycleDays;
  if (parsed.anchorDay !== undefined) input.anchorDay = parsed.anchorDay;
  if (parsed.startedAt !== undefined) input.startedAt = parsed.startedAt;
  if (parsed.status !== undefined) input.status = parsed.status;
  if (parsed.autoRenew !== undefined) input.autoRenew = parsed.autoRenew;
  if (parsed.tags !== undefined) input.tags = parsed.tags;
  if (parsed.notes !== undefined) input.notes = parsed.notes;
  if (vendorId !== undefined) input.vendorId = vendorId;
  return input;
}

function failureMessage(cause: unknown): string {
  if (cause instanceof TenantError) return cause.message;
  return "写入失败，请稍后重试";
}

export async function executeSubscriptionImport(
  userId: string,
  csvText: string,
  strategy: ConflictStrategy,
): Promise<ImportExecuteResult> {
  // 服务端重新解析校验，绝不信任客户端的预检结果
  const ctx = await loadContext(userId);
  const analyzed = analyze(ctx, userId, csvText);

  const result: ImportExecuteResult = { created: 0, updated: 0, skipped: 0, failed: [] };
  for (const row of analyzed) {
    const errors = validateCreateRequirements(row, strategy);
    if (errors.length > 0 || row.parsed === null) {
      result.failed.push({ row: row.row, message: errors.join("；") || "校验失败" });
      continue;
    }
    const parsed = row.parsed;
    try {
      const vendorId = await resolveVendorId(ctx, userId, parsed);
      const paymentMethodId = resolvePaymentMethodId(ctx, parsed);
      const conflict =
        row.conflictId !== null
          ? ctx.subscriptions.find((s) => s.id === row.conflictId) ?? null
          : null;

      if (conflict === null) {
        await createRow(userId, parsed, vendorId ?? null, paymentMethodId);
        result.created += 1;
        continue;
      }
      if (strategy === "skip") {
        result.skipped += 1;
        continue;
      }
      if (strategy === "duplicate") {
        if (isExactMatch(parsed, vendorId, paymentMethodId, conflict)) {
          // 重复确认：第一次创建的行与 CSV 已完全一致，不再复制
          result.skipped += 1;
          continue;
        }
        await createRow(userId, parsed, vendorId ?? null, paymentMethodId);
        result.created += 1;
        continue;
      }
      // update：只覆盖 CSV 中出现的列
      await updateSubscription(userId, conflict.id, toUpdateInput(parsed, vendorId));
      if (paymentMethodId !== undefined) {
        // service 层尚不感知 paymentMethodId，落库补写（所有权已在解析时校验）
        await db.subscription.update({
          where: { id: conflict.id },
          data: { paymentMethodId },
        });
      }
      result.updated += 1;
    } catch (cause) {
      result.failed.push({ row: row.row, message: failureMessage(cause) });
    }
  }
  return result;
}

async function createRow(
  userId: string,
  parsed: ParsedRow,
  vendorId: string | null,
  paymentMethodId: string | null | undefined,
): Promise<void> {
  // validateCreateRequirements 已保证必填四要素存在；这里硬校验兜底，绝不静默默认
  if (
    parsed.price === undefined ||
    parsed.currency === undefined ||
    parsed.billingCycle === undefined ||
    parsed.startedAt === undefined
  ) {
    throw new TenantError("invalid_input", "新建缺少 price/currency/billing_cycle/started_at");
  }
  const created = await createSubscription(userId, {
    name: parsed.name,
    planName: parsed.planName ?? null,
    status: parsed.status ?? "active",
    price: parsed.price,
    currency: parsed.currency,
    billingCycle: parsed.billingCycle,
    cycleDays: parsed.cycleDays ?? null,
    anchorDay: parsed.anchorDay ?? null,
    startedAt: parsed.startedAt,
    autoRenew: parsed.autoRenew ?? true,
    tags: parsed.tags ?? [],
    notes: parsed.notes ?? null,
    vendorId,
  });
  if (paymentMethodId !== undefined) {
    await db.subscription.update({
      where: { id: created.id },
      data: { paymentMethodId },
    });
  }
}
