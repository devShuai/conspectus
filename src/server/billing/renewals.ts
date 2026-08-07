import { db } from "@/server/db";
import { nextBillingDate } from "@/server/billing/cycle";
import { MAX_TZ_OFFSET_MS, dateKey, localToday } from "@/server/billing/local-date";

export const MAX_CATCHUP_CYCLES = 24;

/**
 * Hourly renewal/trial advancement (design.md §7.2):
 * - "today" is resolved per user timezone, not from UTC `now` (#65)
 * - each subscription is locked, re-checked and mutated inside one
 *   transaction, so the row lock actually covers the mutation (#65)
 * - pending charges are inserted with SQL-level ON CONFLICT DO NOTHING; a JS
 *   `catch` around a failing statement cannot un-abort a Postgres transaction
 *   and would poison every statement after it (#65)
 * - autoRenew=false → atomic expired with nextBillingAt=null, no pending
 * - trial autoRenew=true → first pending at trialEndsAt, then active; the
 *   trialEndsAt value is kept as the historical record (#63)
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

  /**
   * Conflict-tolerant insert. `createMany` maps to INSERT ... ON CONFLICT DO
   * NOTHING, so a duplicate occurrenceKey is absorbed by Postgres instead of
   * aborting the surrounding transaction.
   */
  async function insertPending(
    tx: Parameters<Parameters<typeof db.$transaction>[0]>[0],
    sub: {
      id: string;
      userId: string;
      price: unknown;
      currency: string;
      billingCycle: string;
      anchorDay: number | null;
      cycleDays: number | null;
    },
    billedAt: Date,
  ): Promise<boolean> {
    const periodEnd =
      nextBillingDate(billedAt, sub.billingCycle as never, {
        anchorDay: sub.anchorDay,
        cycleDays: sub.cycleDays,
      }) ?? billedAt;
    const created = await tx.billingRecord.createMany({
      data: [
        {
          userId: sub.userId,
          subscriptionId: sub.id,
          amount: sub.price as never,
          currency: sub.currency,
          recordType: "charge",
          billedAt,
          periodStart: billedAt,
          periodEnd,
          status: "pending",
          source: "system",
          occurrenceKey: `${sub.id}:${dateKey(billedAt)}`,
        },
      ],
      skipDuplicates: true,
    });
    return created.count === 1;
  }

  // Candidate window is generous (UTC+14) and then narrowed per user timezone.
  const horizon = new Date(now.getTime() + MAX_TZ_OFFSET_MS);

  // 1) Due active subscriptions
  const active = await db.subscription.findMany({
    where: {
      status: "active",
      nextBillingAt: { not: null, lte: horizon },
    },
    include: { user: { select: { timezone: true } } },
    take: 500,
  });
  for (const sub of active) {
    if (sub.billingCycle === "lifetime" || sub.billingCycle === "one_time") {
      continue;
    }
    if (!sub.nextBillingAt) continue;

    const today = localToday(now, sub.user.timezone);
    if (sub.nextBillingAt > today) continue; // not due in the user's calendar yet

    if (!sub.autoRenew) {
      // atomic expired, no pending bill
      const updated = await db.subscription.updateMany({
        where: { id: sub.id, status: "active", nextBillingAt: sub.nextBillingAt },
        data: { status: "expired", nextBillingAt: null, endedAt: now },
      });
      if (updated.count === 1) expired++;
      continue;
    }

    const dueDate = sub.nextBillingAt;

    const catchup = await db.$transaction(async (tx) => {
      // Lock, re-check and mutate inside the SAME transaction: a lock taken in
      // a separate transaction is released at its commit and protects nothing.
      const locked = await tx.$queryRaw<
        Array<{ id: string }>
      >`SELECT id FROM "subscriptions" WHERE id = ${sub.id}::uuid FOR UPDATE`;
      if (locked.length !== 1) return 0;
      const current = await tx.subscription.findUnique({
        where: { id: sub.id },
        select: { status: true, nextBillingAt: true },
      });
      if (current?.status !== "active") return 0;
      if (!current.nextBillingAt || current.nextBillingAt > dueDate) return 0;

      let periods = 0;
      let cursor = current.nextBillingAt;
      let guard = 0;
      while (cursor <= today && guard < MAX_CATCHUP_CYCLES) {
        if (await insertPending(tx, sub, cursor)) periods++;
        const nextCursor = nextBillingDate(cursor, sub.billingCycle, {
          anchorDay: sub.anchorDay,
          cycleDays: sub.cycleDays,
        });
        if (!nextCursor) break;
        cursor = nextCursor;
        guard++;
      }
      if (guard >= MAX_CATCHUP_CYCLES && cursor <= today) {
        // still behind; the next run picks up from the advanced cursor
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
      trialEndsAt: { not: null, lte: horizon },
    },
    include: { user: { select: { timezone: true } } },
    take: 500,
  });
  for (const trial of trials) {
    const trialEndsAt = trial.trialEndsAt;
    if (!trialEndsAt) continue;

    const today = localToday(now, trial.user.timezone);
    if (trialEndsAt > today) continue;

    // Whole transition in one transaction: lock -> CAS re-check -> write.
    const outcome = await db.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<
        Array<{ id: string }>
      >`SELECT id FROM "subscriptions" WHERE id = ${trial.id}::uuid FOR UPDATE`;
      if (locked.length !== 1) return "skipped" as const;
      const current = await tx.subscription.findUnique({
        where: { id: trial.id },
        select: { status: true, trialEndsAt: true },
      });
      if (current?.status !== "trial" || !current.trialEndsAt) return "skipped" as const;
      if (current.trialEndsAt.getTime() !== trialEndsAt.getTime()) return "skipped" as const;

      if (!trial.autoRenew) {
        // No bill; trialEndsAt is kept as the record of why this expired (#63).
        await tx.subscription.update({
          where: { id: trial.id },
          data: { status: "expired", nextBillingAt: null, endedAt: now },
        });
        return "expired" as const;
      }

      await insertPending(tx, trial, trialEndsAt);
      const next = nextBillingDate(trialEndsAt, trial.billingCycle, {
        anchorDay: trial.anchorDay,
        cycleDays: trial.cycleDays,
      });
      // trialEndsAt stays: it anchors this first occurrenceKey and records
      // when the trial ended (#63).
      await tx.subscription.update({
        where: { id: trial.id },
        data: { status: "active", nextBillingAt: next },
      });
      return "activated" as const;
    });

    if (outcome === "expired") trialExpired++;
    else if (outcome === "activated") trialActivated++;
  }

  return { advanced, expired, trialActivated, trialExpired, skipped };
}
