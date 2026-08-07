import { db } from "@/server/db";
import { identityGateOk } from "@/server/auth/identity-status";
import type { Prisma } from "@prisma/client";

export interface RuleConfig {
  daysBefore?: number[];
  percent?: number[];
  minValue?: number;
  minDaysLeft?: number;
  days?: number;
}

type JsonRecord = Prisma.InputJsonValue;

/** Create/refresh arm state; returns armKey when this worker won the CAS. */
export async function armOrSkip(input: {
  userId: string;
  ruleId: string;
  subjectType: string;
  subjectId: string;
  armKey: string;
  now?: Date;
}): Promise<string | null> {
  const now = input.now ?? new Date();
  const existing = await db.notificationArmState.findUnique({
    where: {
      ruleId_subjectType_subjectId: {
        ruleId: input.ruleId,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
      },
    },
  });
  if (existing) {
    if (existing.clearedAt === null) return null; // already armed
    // cleared → re-arm with fresh armKey
    const updated = await db.notificationArmState.updateMany({
      where: {
        id: existing.id,
        clearedAt: { not: null },
      },
      data: { armedAt: now, clearedAt: null, armKey: input.armKey },
    });
    return updated.count === 1 ? input.armKey : null;
  }
  const created = await db.notificationArmState.create({
    data: {
      userId: input.userId,
      ruleId: input.ruleId,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      armedAt: now,
      armKey: input.armKey,
    },
  }).catch(() => null);
  return created ? input.armKey : null;
}

export async function clearArm(
  input: {
    ruleId: string;
    subjectType: string;
    subjectId: string;
    now?: Date;
  },
): Promise<void> {
  await db.notificationArmState.updateMany({
    where: {
      ruleId: input.ruleId,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      clearedAt: null,
    },
    data: { clearedAt: input.now ?? new Date() },
  });
}

/** Emit an Event + per-channel Deliveries in one transaction. */
export async function emitEvent(input: {
  userId: string;
  ruleId: string;
  subjectType: string;
  subjectId: string;
  dedupeKey: string;
  payload: JsonRecord;
  occurredAt?: Date;
}): Promise<{ eventId: string } | null> {
  const occurredAt = input.occurredAt ?? new Date();
  return db.$transaction(async (tx) => {
    const event = await tx.notificationEvent.create({
      data: {
        userId: input.userId,
        ruleId: input.ruleId,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        dedupeKey: input.dedupeKey,
        payload: input.payload,
        occurredAt,
      },
    }).catch((cause: unknown) => {
      const err = cause as { code?: string };
      if (err.code === "P2002") return null; // dedupe hit
      throw cause;
    });
    if (!event) return null;

    const channels = await tx.notificationChannel.findMany({
      where: { userId: input.userId, enabled: true },
    });
    for (const channel of channels) {
      const scheduledAt =
        channel.mode === "daily_digest"
          ? nextDigestTime(occurredAt)
          : occurredAt;
      await tx.notificationDelivery.create({
        data: {
          userId: input.userId,
          eventId: event.id,
          channelId: channel.id,
          scheduledAt,
        },
      }).catch(() => undefined); // (eventId, channelId) unique
    }
    return { eventId: event.id };
  });
}

function nextDigestTime(now: Date): Date {
  // local 09:00 next occurrence (UTC approximation for M3)
  const next = new Date(now);
  next.setUTCHours(9, 0, 0, 0);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

/** Hourly scan: renewal_due / trial_ending evaluation (collector_stale lands with M4 devices). */
export async function runNotificationScan(now: Date = new Date()): Promise<{
  events: number;
  skipped: number;
}> {
  let events = 0;
  let skipped = 0;

  const rules = await db.notificationRule.findMany({
    where: { enabled: true },
    include: { user: true },
  });

  for (const rule of rules) {
    const user = rule.user;
    if (user.status === "suspended") {
      skipped++;
      continue;
    }
    const gate = await identityGateOk(rule.userId, now);
    if (!gate.ok) {
      skipped++;
      continue;
    }

    const config = rule.config as unknown as RuleConfig;
    const daysBefore = config.daysBefore ?? [7, 1];

    if (rule.type === "renewal_due" || rule.type === "trial_ending") {
      const field = rule.type === "renewal_due" ? "nextBillingAt" : "trialEndsAt";
      const subjects = await db.subscription.findMany({
        where: {
          userId: rule.userId,
          status: { in: ["active", "trial"] },
          [field]: { not: null },
        },
      });
      for (const sub of subjects) {
        const due = (sub as unknown as Record<string, Date | null>)[field];
        if (!due) continue;
        const days = Math.ceil((due.getTime() - now.getTime()) / 86_400_000);
        if (days < 0) continue;
        if (daysBefore.includes(days)) {
          const key = `${rule.type === "renewal_due" ? "renewal" : "trial"}:${due.toISOString().slice(0, 10)}:d${days}`;
          const emitted = await emitEvent({
            userId: rule.userId,
            ruleId: rule.id,
            subjectType: "subscription",
            subjectId: sub.id,
            dedupeKey: key,
            payload: { subscriptionId: sub.id, name: sub.name, dueDate: due.toISOString() },
            occurredAt: now,
          });
          if (emitted) events++;
        }
      }
    }
  }

  return { events, skipped };
}
