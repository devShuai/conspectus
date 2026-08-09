import type { BillingCycle, SubscriptionStatus, VendorCategory } from "@prisma/client";

import { db } from "@/server/db";
import {
  deriveAnchorDay,
  nextBillingDate,
  nextBillingOnOrAfter,
} from "@/server/billing/cycle";
import { isSupportedCurrency } from "@/server/billing/fx";
import { localToday } from "@/server/billing/local-date";

/** All business writes must carry the session-derived userId (never client input). */
export type TenantUserId = string;

export class TenantError extends Error {
  constructor(
    public readonly code:
      | "not_found"
      | "forbidden"
      | "invalid_input"
      | "conflict",
    message: string,
  ) {
    super(message);
    this.name = "TenantError";
  }
}

export interface CreateSubscriptionInput {
  name: string;
  planName?: string | null;
  status: SubscriptionStatus;
  price: number;
  currency: string;
  billingCycle: BillingCycle;
  cycleDays?: number | null;
  anchorDay?: number | null;
  startedAt: Date;
  trialEndsAt?: Date | null;
  autoRenew?: boolean;
  tags?: string[];
  notes?: string | null;
  vendorId?: string | null;
}

export interface UpdateSubscriptionInput {
  name?: string;
  planName?: string | null;
  status?: SubscriptionStatus;
  price?: number;
  currency?: string;
  billingCycle?: BillingCycle;
  cycleDays?: number | null;
  anchorDay?: number | null;
  startedAt?: Date;
  trialEndsAt?: Date | null;
  autoRenew?: boolean;
  tags?: string[];
  notes?: string | null;
  vendorId?: string | null;
}

const VALID_CURRENCY = /^[A-Z]{3}$/;

function validateSubscriptionInput(
  input: CreateSubscriptionInput | UpdateSubscriptionInput,
): void {
  if (input.price !== undefined && (input.price < 0 || !Number.isFinite(input.price))) {
    throw new TenantError("invalid_input", "price must be a non-negative number");
  }
  if (input.currency !== undefined && !VALID_CURRENCY.test(input.currency)) {
    throw new TenantError("invalid_input", "currency must be ISO-4217 (3 letters)");
  }
  // §7.3 / #106：汇率源不覆盖的币种录入时即拒绝（订阅实体没有固定汇率字段，
  // 退无可退），绝不静默按 0 计入统计
  if (input.currency !== undefined && !isSupportedCurrency(input.currency)) {
    throw new TenantError("invalid_input", "currency is not covered by the fx source");
  }
  if (
    input.billingCycle === "custom" &&
    (input.cycleDays === undefined || input.cycleDays === null || input.cycleDays <= 0)
  ) {
    throw new TenantError("invalid_input", "custom cycle requires positive cycleDays");
  }
  if (
    input.billingCycle !== "custom" &&
    input.cycleDays !== undefined &&
    input.cycleDays !== null
  ) {
    throw new TenantError(
      "invalid_input",
      "cycleDays is only valid for custom billing cycle",
    );
  }
  if (
    input.anchorDay !== undefined &&
    input.anchorDay !== null &&
    (input.anchorDay < 1 || input.anchorDay > 31)
  ) {
    throw new TenantError("invalid_input", "anchorDay must be between 1 and 31");
  }
  // One-way only (design §6.2, #63): a trial must carry trialEndsAt, but a
  // converted/expired subscription keeps it as the historical record of when
  // the trial ended -- it also anchors the first billing occurrenceKey.
  if (input.status === "trial" && !input.trialEndsAt) {
    throw new TenantError("invalid_input", "trial requires trialEndsAt");
  }
}

async function assertVendorAllowed(
  userId: string,
  vendorId: string | null | undefined,
): Promise<void> {
  if (!vendorId) return;
  const vendor = await db.vendor.findUnique({ where: { id: vendorId } });
  if (!vendor || (vendor.userId !== null && vendor.userId !== userId)) {
    throw new TenantError("forbidden", "vendor is not visible to this user");
  }
  if (vendor.userId === null) {
    return; // system vendor is readable by all
  }
  if (vendor.userId !== userId) {
    throw new TenantError("forbidden", "private vendor belongs to another user");
  }
}

export async function createSubscription(
  userId: TenantUserId,
  input: CreateSubscriptionInput,
) {
  validateSubscriptionInput(input);
  await assertVendorAllowed(userId, input.vendorId);

  const startedAt = new Date(
    Date.UTC(
      input.startedAt.getUTCFullYear(),
      input.startedAt.getUTCMonth(),
      input.startedAt.getUTCDate(),
    ),
  );
  // 锚定日单独固化（§7.2）：月/季/年周期缺省时取 startedAt 的日，
  // 绝不允许从 nextBillingAt 反推导致逐段漂移（#104）
  const anchorDay = deriveAnchorDay(input.billingCycle, startedAt, input.anchorDay);
  const next = nextBillingDate(startedAt, input.billingCycle, {
    anchorDay,
    cycleDays: input.cycleDays,
  });

  return db.subscription.create({
    data: {
      userId,
      vendorId: input.vendorId ?? null,
      name: input.name,
      planName: input.planName ?? null,
      status: input.status,
      price: input.price,
      currency: input.currency,
      billingCycle: input.billingCycle,
      cycleDays: input.cycleDays ?? null,
      anchorDay,
      startedAt,
      nextBillingAt: next,
      trialEndsAt: input.trialEndsAt ?? null,
      autoRenew: input.autoRenew ?? true,
      tags: input.tags ?? [],
      notes: input.notes ?? null,
    },
  });
}

export async function listSubscriptions(userId: TenantUserId) {
  return db.subscription.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });
}

export async function getSubscription(userId: TenantUserId, id: string) {
  const sub = await db.subscription.findFirst({ where: { id, userId } });
  if (!sub) throw new TenantError("not_found", "subscription not found");
  return sub;
}

export async function updateSubscription(
  userId: TenantUserId,
  id: string,
  input: UpdateSubscriptionInput,
) {
  const existing = await getSubscription(userId, id);
  const merged = {
    ...existing,
    ...input,
    status: input.status ?? existing.status,
    billingCycle: input.billingCycle ?? existing.billingCycle,
    price: input.price ?? Number(existing.price),
    currency: input.currency ?? existing.currency,
    startedAt: input.startedAt ?? existing.startedAt,
    anchorDay: input.anchorDay !== undefined ? input.anchorDay : existing.anchorDay,
    cycleDays: input.cycleDays !== undefined ? input.cycleDays : existing.cycleDays,
    trialEndsAt: input.trialEndsAt !== undefined ? input.trialEndsAt : existing.trialEndsAt,
    vendorId: input.vendorId !== undefined ? input.vendorId : existing.vendorId,
  } as CreateSubscriptionInput;
  // 顺手回填历史行的锚定日（月/季/年缺省取 startedAt 的日，显式值不动）
  merged.anchorDay = deriveAnchorDay(merged.billingCycle, merged.startedAt, merged.anchorDay);
  validateSubscriptionInput(merged);
  await assertVendorAllowed(userId, merged.vendorId);

  // 只有账期四要素变化、或 paused → active 恢复时才重算（§7.2 / #104）；
  // 重算一律推到「下一个未来账期」，绝不落过去 —— 追补只服务任务停摆，
  // 用户编辑与恢复都不该被追成一串 pending。
  const cycleFieldsChanged =
    merged.billingCycle !== existing.billingCycle ||
    merged.anchorDay !== existing.anchorDay ||
    merged.cycleDays !== existing.cycleDays ||
    merged.startedAt.getTime() !== existing.startedAt.getTime();
  const resumed = existing.status === "paused" && merged.status === "active";

  let nextBillingAt = existing.nextBillingAt;
  if (resumed || cycleFieldsChanged) {
    const user = await db.user.findUniqueOrThrow({
      where: { id: userId },
      select: { timezone: true },
    });
    nextBillingAt = nextBillingOnOrAfter(
      localToday(new Date(), user.timezone),
      merged.startedAt,
      merged.billingCycle,
      { anchorDay: merged.anchorDay, cycleDays: merged.cycleDays },
    );
  }

  const updated = await db.subscription.update({
    where: { id: existing.id },
    data: {
      name: merged.name,
      planName: merged.planName ?? null,
      status: merged.status,
      price: merged.price,
      currency: merged.currency,
      billingCycle: merged.billingCycle,
      cycleDays: merged.cycleDays ?? null,
      anchorDay: merged.anchorDay ?? null,
      nextBillingAt,
      trialEndsAt: merged.trialEndsAt ?? null,
      autoRenew: input.autoRenew ?? existing.autoRenew,
      tags: input.tags ?? existing.tags,
      notes: input.notes !== undefined ? input.notes : existing.notes,
      vendorId: merged.vendorId ?? null,
    },
  });

  // price_change 检测与求值入口（§7.6 / #114）：价格变动落 PriceChange 并出事件
  if (input.price !== undefined && Number(input.price) !== Number(existing.price)) {
    const priceChange = await db.priceChange.create({
      data: {
        userId,
        subscriptionId: existing.id,
        oldPrice: existing.price,
        newPrice: input.price,
        currency: merged.currency,
        detectedBy: "user",
        effectiveAt: new Date(),
      },
    });
    const vendor = merged.vendorId
      ? await db.vendor.findUnique({ where: { id: merged.vendorId }, select: { name: true } })
      : null;
    const { notifyPriceChange } = await import("@/server/notify/usage-rules");
    await notifyPriceChange({
      userId,
      priceChangeId: priceChange.id,
      subscriptionId: existing.id,
      name: updated.name,
      vendor: vendor?.name ?? null,
      oldPrice: String(existing.price),
      newPrice: String(input.price),
      currency: updated.currency,
      detectedBy: "user",
      effectiveAt: priceChange.effectiveAt,
    });
  }

  return updated;
}

export async function changeSubscriptionStatus(
  userId: TenantUserId,
  id: string,
  status: SubscriptionStatus,
) {
  const existing = await getSubscription(userId, id);
  if (status === "trial" && !existing.trialEndsAt) {
    throw new TenantError("invalid_input", "trial requires trialEndsAt");
  }

  // paused → active：从恢复日推到下一个未来账期，绝不补账（§7.2 / #104）
  let nextBillingAt: Date | null | undefined;
  if (existing.status === "paused" && status === "active") {
    const user = await db.user.findUniqueOrThrow({
      where: { id: userId },
      select: { timezone: true },
    });
    nextBillingAt = nextBillingOnOrAfter(
      localToday(new Date(), user.timezone),
      existing.startedAt,
      existing.billingCycle,
      { anchorDay: existing.anchorDay, cycleDays: existing.cycleDays },
    );
  }

  return db.subscription.update({
    where: { id: existing.id },
    data: { status, ...(nextBillingAt !== undefined ? { nextBillingAt } : {}) },
  });
}

export async function deleteSubscription(userId: TenantUserId, id: string) {
  const existing = await getSubscription(userId, id);
  await db.subscription.delete({ where: { id: existing.id } });
}

// ---------------- Vendors ----------------

export interface CreateVendorInput {
  slug: string;
  name: string;
  category: VendorCategory;
  homepage?: string | null;
  cancelUrl?: string | null;
  logoUrl?: string | null;
}

export async function listVendors(userId: TenantUserId) {
  return db.vendor.findMany({
    where: { OR: [{ userId: null }, { userId }] },
    orderBy: { name: "asc" },
  });
}

export async function createPrivateVendor(userId: TenantUserId, input: CreateVendorInput) {
  const normalized = input.slug.trim().toLowerCase();
  if (!/^[a-z0-9-]{2,64}$/.test(normalized)) {
    throw new TenantError("invalid_input", "slug must be 2-64 chars of a-z0-9-");
  }
  const conflict = await db.vendor.findFirst({
    where: { userId, slug: normalized },
  });
  if (conflict) throw new TenantError("conflict", "slug already used for this user");
  return db.vendor.create({
    data: {
      slug: normalized,
      name: input.name,
      category: input.category,
      homepage: input.homepage ?? null,
      cancelUrl: input.cancelUrl ?? null,
      logoUrl: input.logoUrl ?? null,
      userId,
    },
  });
}

export async function updatePrivateVendor(
  userId: TenantUserId,
  id: string,
  input: Partial<CreateVendorInput>,
) {
  const vendor = await db.vendor.findFirst({ where: { id, userId } });
  if (!vendor) throw new TenantError("not_found", "vendor not found");
  return db.vendor.update({
    where: { id: vendor.id },
    data: {
      name: input.name ?? vendor.name,
      category: input.category ?? vendor.category,
      homepage: input.homepage !== undefined ? input.homepage : vendor.homepage,
      cancelUrl: input.cancelUrl !== undefined ? input.cancelUrl : vendor.cancelUrl,
      logoUrl: input.logoUrl !== undefined ? input.logoUrl : vendor.logoUrl,
    },
  });
}

export async function deletePrivateVendor(userId: TenantUserId, id: string) {
  const vendor = await db.vendor.findFirst({ where: { id, userId } });
  if (!vendor) throw new TenantError("not_found", "vendor not found");
  await db.vendor.delete({ where: { id: vendor.id } });
}
