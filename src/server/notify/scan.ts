import { db } from "@/server/db";
import type { Prisma } from "@prisma/client";

import { localToday } from "@/server/billing/local-date";
import { localDaysBetween, nextLocalTime } from "./schedule";

export interface RuleConfig {
  daysBefore?: number[];
  percent?: number[];
  minValue?: number;
  minDaysLeft?: number;
  days?: number;
}

type JsonRecord = Prisma.InputJsonValue;

type ArmInput = {
  userId: string;
  ruleId: string;
  subjectType: string;
  subjectId: string;
  armKey: string;
  now?: Date;
};

/** Create/refresh arm state; returns armKey when this worker won the CAS. */
export async function armOrSkip(input: ArmInput): Promise<string | null> {
  return armInTx(db, input, input.now ?? new Date());
}

type Tx = Prisma.TransactionClient;

async function armInTx(tx: Tx, input: ArmInput, now: Date): Promise<string | null> {
  const existing = await tx.notificationArmState.findUnique({
    where: {
      userId_ruleId_subjectType_subjectId: {
        userId: input.userId,
        ruleId: input.ruleId,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
      },
    },
  });
  if (existing) {
    if (existing.clearedAt === null) return null; // already armed
    const updated = await tx.notificationArmState.updateMany({
      where: {
        userId: input.userId,
        ruleId: input.ruleId,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        clearedAt: { not: null },
      },
      data: { armedAt: now, clearedAt: null, armKey: input.armKey },
    });
    return updated.count === 1 ? input.armKey : null;
  }
  // skipDuplicates → ON CONFLICT DO NOTHING；P2002 会中止整个事务，JS catch 解不掉
  const created = await tx.notificationArmState.createMany({
    data: [
      {
        userId: input.userId,
        ruleId: input.ruleId,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        armedAt: now,
        armKey: input.armKey,
      },
    ],
    skipDuplicates: true,
  });
  return created.count === 1 ? input.armKey : null;
}

export async function clearArm(input: {
  ruleId: string;
  subjectType: string;
  subjectId: string;
  now?: Date;
}): Promise<void> {
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

/** reminder（续费/试用）默认用户本地 09:00；操作性告警立即投递（§7.6）。 */
type EventKind = "reminder" | "operational";

/** 摘要时刻（本地小时）；#116 落地 digestLocalTime 后按渠道覆盖。 */
const DIGEST_LOCAL_HOUR = 9;

function scheduledFor(
  channel: { mode: string },
  kind: EventKind,
  occurredAt: Date,
  timezone: string,
): Date {
  if (kind === "reminder") return nextLocalTime(occurredAt, timezone, 9);
  return occurredAt;
}

/**
 * daily_digest 入队（§7.6 / #91）：计算「严格晚于入队当前时刻」的下一摘要本地
 * 日期，upsert (channelId, localDate) 批次并把 Delivery 关联过去（刻意不用
 * occurredAt —— 回填的旧事件也不得把批次排到过去）。
 * 已非 pending 的批次（发送中/已发送/已终态）不接收迟到事件，顺延到下一个摘要日；
 * 终态批次只可能属于过去的摘要时刻，顺延循环必然在 pending 批次上收敛。
 */
async function upsertDigestBatch(
  tx: Tx,
  input: { userId: string; channelId: string; timezone: string },
): Promise<{ id: string; scheduledAt: Date }> {
  let from = new Date();
  for (let roll = 0; roll < 10; roll++) {
    const scheduledAt = nextLocalTime(from, input.timezone, DIGEST_LOCAL_HOUR);
    const localDate = localToday(scheduledAt, input.timezone);
    const digest = await tx.notificationDigest.upsert({
      where: { channelId_localDate: { channelId: input.channelId, localDate } },
      create: {
        userId: input.userId,
        channelId: input.channelId,
        localDate,
        scheduledAt,
      },
      update: {},
    });
    if (digest.status === "pending") {
      return { id: digest.id, scheduledAt: digest.scheduledAt };
    }
    from = digest.scheduledAt;
  }
  throw new Error("digest batch roll-forward did not converge");
}

async function insertDeliveries(
  tx: Tx,
  input: { userId: string; eventId: string; kind: EventKind; occurredAt: Date; timezone: string },
): Promise<void> {
  const channels = await tx.notificationChannel.findMany({
    where: { userId: input.userId, enabled: true },
  });
  for (const channel of channels) {
    if (channel.mode === "daily_digest") {
      const digest = await upsertDigestBatch(tx, {
        userId: input.userId,
        channelId: channel.id,
        timezone: input.timezone,
      });
      await tx.notificationDelivery.createMany({
        data: [
          {
            userId: input.userId,
            eventId: input.eventId,
            channelId: channel.id,
            digestId: digest.id,
            scheduledAt: digest.scheduledAt,
          },
        ],
        skipDuplicates: true, // (eventId, channelId) unique
      });
      continue;
    }
    const scheduledAt = scheduledFor(channel, input.kind, input.occurredAt, input.timezone);
    await tx.notificationDelivery.createMany({
      data: [
        {
          userId: input.userId,
          eventId: input.eventId,
          channelId: channel.id,
          scheduledAt,
        },
      ],
      skipDuplicates: true, // (eventId, channelId) unique
    });
  }
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
  kind?: EventKind;
}): Promise<{ eventId: string } | null> {
  const occurredAt = input.occurredAt ?? new Date();
  const kind = input.kind ?? "operational";
  return db.$transaction(async (tx) => {
    const event = await insertEvent(tx, input, occurredAt);
    if (!event) return null;
    const user = await tx.user.findUniqueOrThrow({
      where: { id: input.userId },
      select: { timezone: true },
    });
    await insertDeliveries(tx, {
      userId: input.userId,
      eventId: event.id,
      kind,
      occurredAt,
      timezone: user.timezone,
    });
    return { eventId: event.id };
  });
}

/**
 * ArmState 原子迁移（§7.6）：arm CAS、Event、Delivery 同事务，
 * 只有 CAS 胜出的事务才建事件 —— 两个扫描 worker 不会都读到「可告警」后各建一次。
 */
export async function emitArmedEvent(input: {
  userId: string;
  ruleId: string;
  subjectType: string;
  subjectId: string;
  dedupeKey: string;
  payload: JsonRecord;
  arm: Omit<ArmInput, "userId" | "ruleId" | "subjectType" | "subjectId">;
  occurredAt?: Date;
  kind?: EventKind;
}): Promise<{ eventId: string } | null> {
  const occurredAt = input.occurredAt ?? new Date();
  const kind = input.kind ?? "operational";
  return db.$transaction(async (tx) => {
    const won = await armInTx(
      tx,
      {
        userId: input.userId,
        ruleId: input.ruleId,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        armKey: input.arm.armKey,
      },
      occurredAt,
    );
    if (!won) return null;
    const event = await insertEvent(
      tx,
      {
        userId: input.userId,
        ruleId: input.ruleId,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        // armKey 写入 dedupeKey 片段（§7.6）：同一 episode 并发只有一个事件，
        // clear 后的新一轮 episode 用新 armKey 自然换 key
        dedupeKey: `${input.dedupeKey}#${won}`,
        payload: input.payload,
      },
      occurredAt,
    );
    if (!event) return null;
    const user = await tx.user.findUniqueOrThrow({
      where: { id: input.userId },
      select: { timezone: true },
    });
    await insertDeliveries(tx, {
      userId: input.userId,
      eventId: event.id,
      kind,
      occurredAt,
      timezone: user.timezone,
    });
    return { eventId: event.id };
  });
}

async function insertEvent(
  tx: Tx,
  input: {
    userId: string;
    ruleId: string;
    subjectType: string;
    subjectId: string;
    dedupeKey: string;
    payload: JsonRecord;
  },
  occurredAt: Date,
): Promise<{ id: string } | null> {
  // 规则/用户在扫描途中被并发删除是常态（清理、删号）——FOR SHARE 既防误插孤儿行，
  // 也避免 FK 违例中止整个扫描事务（deletion 等我们的锁而不是报错）
  const rule = await tx.$queryRaw<
    Array<{ id: string }>
  >`SELECT id FROM "notification_rules" WHERE id = ${input.ruleId}::uuid FOR SHARE`;
  if (rule.length !== 1) return null;
  const user = await tx.$queryRaw<
    Array<{ id: string }>
  >`SELECT id FROM "users" WHERE id = ${input.userId}::uuid FOR SHARE`;
  if (user.length !== 1) return null;

  const created = await tx.notificationEvent.createMany({
    data: [
      {
        userId: input.userId,
        ruleId: input.ruleId,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        dedupeKey: input.dedupeKey,
        payload: input.payload,
        occurredAt,
      },
    ],
    skipDuplicates: true, // dedupe 冲突由唯一键吸收，不毒死事务
  });
  if (created.count !== 1) return null;
  return tx.notificationEvent.findFirst({
    where: {
      userId: input.userId,
      ruleId: input.ruleId,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      dedupeKey: input.dedupeKey,
    },
    select: { id: true },
  });
}

/** Hourly scan: renewal_due / trial_ending evaluation (其余类型的求值入口见各自模块)。 */
export async function runNotificationScan(now: Date = new Date()): Promise<{
  events: number;
  skipped: number;
}> {
  let events = 0;
  let skipped = 0;

  const rules = await db.notificationRule.findMany({
    where: { enabled: true },
    include: { user: { select: { id: true, status: true, timezone: true } } },
  });

  for (const rule of rules) {
    const user = rule.user;
    if (user.status === "suspended") {
      skipped++;
      continue;
    }
    // 不在扫描阶段吞事件（#110）：身份问题留到投递侧以 pending 延迟，
    // 单阈值规则（如 [7]）在身份恢复后不会永久丢失该次提醒

    const config = rule.config as unknown as RuleConfig;
    const daysBefore = config.daysBefore ?? [7, 1];

    if (rule.type === "collector_stale") {
      // 每小时扫描设备离线（§7.6 / #114）：基准时间冻结故离线期间只提醒一次；
      // 恢复上报后再离线自然换键。已撤销设备不报警（§7.6 过滤）。
      const thresholdDays = config.days ?? 3;
      const devices = await db.collectorDevice.findMany({
        where: { userId: rule.userId, revokedAt: null },
      });
      const today = localToday(now, user.timezone);
      for (const device of devices) {
        const baseline = device.lastSeenAt ?? device.createdAt;
        const offlineDays = localDaysBetween(baseline, today, user.timezone);
        if (offlineDays < thresholdDays) continue;
        const emitted = await emitEvent({
          userId: rule.userId,
          ruleId: rule.id,
          subjectType: "device",
          subjectId: device.id,
          dedupeKey: `stale:${baseline.toISOString().slice(0, 10)}`,
          payload: {
            deviceId: device.id,
            deviceName: device.name,
            days: offlineDays,
            baselineAt: baseline.toISOString(),
          },
          occurredAt: now,
        });
        if (emitted) events++;
      }
      continue;
    }

    if (rule.type === "renewal_due" || rule.type === "trial_ending") {
      // 扫描必须带 subject 状态过滤（§7.6）：renewal 只看 active，trial 只看 trial
      const field = rule.type === "renewal_due" ? "nextBillingAt" : "trialEndsAt";
      const status = rule.type === "renewal_due" ? "active" : "trial";
      const subjects = await db.subscription.findMany({
        where: {
          userId: rule.userId,
          status,
          [field]: { not: null },
        },
        include: { vendor: { select: { name: true } } },
      });
      const today = localToday(now, user.timezone);
      for (const sub of subjects) {
        const due = (sub as unknown as Record<string, Date | null>)[field];
        if (!due) continue;
        // 天数按用户时区的日历日差算，不按 UTC 毫秒（#110）
        const days = localDaysBetween(today, due, user.timezone);
        if (days < 0) continue;
        if (daysBefore.includes(days)) {
          const key = `${rule.type === "renewal_due" ? "renewal" : "trial"}:${due.toISOString().slice(0, 10)}:d${days}`;
          const emitted = await emitEvent({
            userId: rule.userId,
            ruleId: rule.id,
            subjectType: "subscription",
            subjectId: sub.id,
            dedupeKey: key,
            kind: "reminder",
            payload: {
              subscriptionId: sub.id,
              name: sub.name,
              vendor: sub.vendor?.name ?? null,
              dueDate: due.toISOString().slice(0, 10),
              daysBefore: days,
              amount: sub.price.toString(),
              currency: sub.currency,
            },
            occurredAt: now,
          });
          if (emitted) events++;
        }
      }
    }
  }

  return { events, skipped };
}
