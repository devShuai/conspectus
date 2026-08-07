import type { BillingCycle, SubscriptionStatus, VendorCategory } from "@prisma/client";

import { db } from "@/server/db";
import { nextBillingDate } from "@/server/billing/cycle";

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
  const next = nextBillingDate(startedAt, input.billingCycle, {
    anchorDay: input.anchorDay,
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
      anchorDay: input.anchorDay ?? null,
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
  validateSubscriptionInput(merged);
  await assertVendorAllowed(userId, merged.vendorId);

  const next = nextBillingDate(merged.startedAt, merged.billingCycle, {
    anchorDay: merged.anchorDay,
    cycleDays: merged.cycleDays,
  });

  return db.subscription.update({
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
      nextBillingAt: next,
      trialEndsAt: merged.trialEndsAt ?? null,
      autoRenew: input.autoRenew ?? existing.autoRenew,
      tags: input.tags ?? existing.tags,
      notes: input.notes !== undefined ? input.notes : existing.notes,
      vendorId: merged.vendorId ?? null,
    },
  });
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
  return db.subscription.update({
    where: { id: existing.id },
    data: { status },
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
