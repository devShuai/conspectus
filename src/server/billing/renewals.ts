import { db } from "@/server/db";
import { nextBillingDate } from "@/server/billing/cycle";

export const MAX_CATCHUP_CYCLES = 24;

/**
 * Hourly renewal/trial advancement (design.md §7.2):
 * - scans due active subscriptions; row-locks + dueDate CAS + occurrenceKey
 *   idempotency, so concurrent runners create each period exactly once
 * - autoRenew=false → atomic expired with nextBillingAt=null, no pending
 * - trial autoRenew=true → first pending at trialEndsAt, then active + advance
 * - paused recovery never back-fills paused periods (handled by caller via
 *   explicit nextBillingAt reset)
 */
export async function runRenewals(now: Date = new Date()): Promise<{
  advanced: number;
  expired: number;
  trialActivated: number;
  trialExpired: number;
  skipped: number;
}> {
  let advanced = 0;
  let expired = 0;
  let trialActivated = 0;
  let trialExpired = 0;
  let skipped = 0;

  // 1) Due active subscriptions
  const active = await db.subscription.findMany({
    where: {
      status: "active",
      nextBillingAt: { not: null, lte: now },
    },
    take: 500,
  });
  for (const sub of active) {
    if (sub.billingCycle === "lifetime" || sub.billingCycle === "one_time") {
      continue;
    }
    if (!sub.autoRenew) {
      // atomic expired, no pending bill
      const updated = await db.subscription.updateMany({
        where: { id: sub.id, status: "active", nextBillingAt: sub.nextBillingAt },
        data: { status: "expired", nextBillingAt: null, endedAt: now },
      });
      if (updated.count === 1) expired++;
      continue;
    }
    if (!sub.nextBillingAt) continue;

    const dueDate = sub.nextBillingAt;
    // advance with compare-and-swap to survive concurrency
    const next = nextBillingDate(dueDate, sub.billingCycle, {
      anchorDay: sub.anchorDay,
      cycleDays: sub.cycleDays,
    });
    if (!next) continue;

    const catchup = await db.$transaction(async (tx) => {
      // lock the row
      const locked = await tx.$queryRaw<
        Array<{ id: string }>
      >`SELECT id FROM "subscriptions" WHERE id = ${sub.id}::uuid FOR UPDATE`;
      if (locked.length !== 1) return 0;
      const current = await tx.subscription.findUnique({
        where: { id: sub.id },
        select: { nextBillingAt: true },
      });
      if (!current?.nextBillingAt || current.nextBillingAt > dueDate) return 0;

      // one pending charge per due date (occurrenceKey idempotent)
      let periods = 0;
      let cursor = current.nextBillingAt;
      let guard = 0;
      while (cursor <= now && guard < MAX_CATCHUP_CYCLES) {
        const key = `${sub.id}:${cursor.toISOString().slice(0, 10)}`;
        const inserted = await tx.billingRecord.create({
          data: {
            userId: sub.userId,
            subscriptionId: sub.id,
            amount: sub.price,
            currency: sub.currency,
            recordType: "charge",
            billedAt: cursor,
            periodStart: cursor,
            periodEnd: nextBillingDate(cursor, sub.billingCycle, {
              anchorDay: sub.anchorDay,
              cycleDays: sub.cycleDays,
            }) ?? cursor,
            status: "pending",
            source: "system",
            occurrenceKey: key,
          },
        }).catch((cause: unknown) => {
          const err = cause as { code?: string };
          if (err.code === "P2002") return null; // already exists
          throw cause;
        });
        if (inserted) periods++;
        const nextCursor = nextBillingDate(cursor, sub.billingCycle, {
          anchorDay: sub.anchorDay,
          cycleDays: sub.cycleDays,
        });
        if (!nextCursor) break;
        cursor = nextCursor;
        guard++;
      }
      if (guard >= MAX_CATCHUP_CYCLES && cursor <= now) {
        // still behind; leave a marker for the next run (skipped)
        skipped++;
      }
      await tx.subscription.update({
        where: { id: sub.id },
        data: { nextBillingAt: cursor },
      });
      return periods;
    });
    advanced += catchup;
  }

  // 2) Due trial subscriptions
  const trials = await db.subscription.findMany({
    where: {
      status: "trial",
      trialEndsAt: { not: null, lte: now },
    },
    take: 500,
  });
  for (const trial of trials) {
    const trialEndsAt = trial.trialEndsAt;
    if (!trialEndsAt) continue;
    // row-lock CAS: only the winning worker proceeds
    const claimed = await db.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<
        Array<{ id: string }>
      >`SELECT id FROM "subscriptions" WHERE id = ${trial.id}::uuid FOR UPDATE`;
      if (locked.length !== 1) return false;
      const current = await tx.subscription.findUnique({
        where: { id: trial.id },
        select: { status: true, trialEndsAt: true },
      });
      if (current?.status !== "trial" || !current.trialEndsAt) return false;
      if (current.trialEndsAt.getTime() !== trialEndsAt.getTime()) return false;
      return true;
    });
    if (!claimed) continue;

    if (!trial.autoRenew) {
      await db.subscription.update({
        where: { id: trial.id },
        data: { status: "expired", nextBillingAt: null, endedAt: now, trialEndsAt: null },
      });
      trialExpired++;
      continue;
    }
    // first pending at trialEndsAt, then active with period anchored at trialEndsAt
    await db.$transaction(async (tx) => {
      const key = `${trial.id}:${trialEndsAt.toISOString().slice(0, 10)}`;
      await tx.billingRecord
        .create({
          data: {
            userId: trial.userId,
            subscriptionId: trial.id,
            amount: trial.price,
            currency: trial.currency,
            recordType: "charge",
            billedAt: trialEndsAt,
            periodStart: trialEndsAt,
            periodEnd: nextBillingDate(trialEndsAt, trial.billingCycle, {
              anchorDay: trial.anchorDay,
              cycleDays: trial.cycleDays,
            }) ?? trialEndsAt,
            status: "pending",
            source: "system",
            occurrenceKey: key,
          },
        })
        .catch(() => undefined);
      const next = nextBillingDate(trialEndsAt, trial.billingCycle, {
        anchorDay: trial.anchorDay,
        cycleDays: trial.cycleDays,
      });
      await tx.subscription.update({
        where: { id: trial.id },
        data: { status: "active", nextBillingAt: next, trialEndsAt: null },
      });
    });
    trialActivated++;
  }

  return { advanced, expired, trialActivated, trialExpired, skipped };
}
