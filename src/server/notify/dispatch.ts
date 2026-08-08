import { db } from "@/server/db";
import { identityGateOk } from "@/server/auth/identity-status";

import { renderNotificationEmail } from "./email-templates";
import { postSafeWebhook } from "./webhook-safe";
import { webhookHeaders } from "./webhook-signing";

export const RETRY_STEPS_MS = [60_000, 300_000, 1_800_000];
// 1min/5min/30min 三次重试之后才 failed（#110：原来是阶梯 off-by-one，30min 档不可达）
const MAX_ATTEMPTS = RETRY_STEPS_MS.length + 1;

const DEFER_MS = 5 * 60_000;

/**
 * Minute dispatcher: lease due deliveries (SKIP LOCKED semantics via
 * updateMany CAS), verify identity/channel/rule/subject before the call, retry
 * 1m/5m/30m, fail after attempts exhausted. Recoverable identity failures
 * return to pending WITHOUT incrementing attempts.
 */
export async function dispatchDueDeliveries(now: Date = new Date()): Promise<{
  sent: number;
  retried: number;
  failed: number;
  blocked: number;
  canceled: number;
  deferred: number;
}> {
  let sent = 0;
  let retried = 0;
  let failed = 0;
  let blocked = 0;
  let canceled = 0;
  let deferred = 0;

  const due = await db.notificationDelivery.findMany({
    where: {
      digestId: null, // 直接发送只租非摘要子项（§7.6 / #91 的批次由 digest worker 消费）
      status: { in: ["pending", "sending"] },
      AND: [
        {
          OR: [
            { scheduledAt: { lte: now } },
            { leaseUntil: { lte: now } },
          ],
        },
        {
          OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
        },
      ],
    },
    take: 50,
  });

  for (const delivery of due) {
    const leaseToken = crypto.randomUUID();
    const leased = await db.notificationDelivery.updateMany({
      where: {
        id: delivery.id,
        AND: [
          {
            OR: [
              { status: "pending", nextAttemptAt: null },
              { status: "pending", nextAttemptAt: { lte: now } },
              { status: "sending", leaseUntil: { lte: now } },
            ],
          },
        ],
      },
      data: {
        status: "sending",
        leaseUntil: new Date(now.getTime() + 60_000),
        leaseToken,
      },
    });
    if (leased.count !== 1) continue;

    const outcome = await preflight(delivery, now);
    if (outcome.action !== "send") {
      await db.notificationDelivery.updateMany({
        where: { id: delivery.id, status: "sending", leaseToken },
        data:
          outcome.action === "cancel"
            ? { status: "canceled", leaseUntil: null, leaseToken: null }
            : outcome.action === "block"
              ? { status: "blocked", leaseUntil: null, leaseToken: null }
              : {
                  status: "pending",
                  leaseUntil: null,
                  leaseToken: null,
                  nextAttemptAt: new Date(now.getTime() + DEFER_MS),
                  lastError: outcome.reason,
                },
      });
      if (outcome.action === "cancel") canceled++;
      else if (outcome.action === "block") blocked++;
      else deferred++;
      continue;
    }

    const ok = await attemptSend(delivery, now);
    if (ok) {
      await db.notificationDelivery.updateMany({
        where: { id: delivery.id, status: "sending", leaseToken },
        data: { status: "sent", sentAt: now, leaseUntil: null, leaseToken: null },
      });
      sent++;
      continue;
    }

    const attempts = delivery.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      await db.notificationDelivery.updateMany({
        where: { id: delivery.id, status: "sending", leaseToken },
        data: { status: "failed", leaseUntil: null, leaseToken: null },
      });
      failed++;
      continue;
    }
    await db.notificationDelivery.updateMany({
      where: { id: delivery.id, status: "sending", leaseToken },
      data: {
        status: "pending",
        attempts,
        nextAttemptAt: new Date(now.getTime() + RETRY_STEPS_MS[attempts - 1]),
        leaseUntil: null,
        leaseToken: null,
        lastError: "delivery_failed",
      },
    });
    retried++;
  }

  return { sent, retried, failed, blocked, canceled, deferred };
}

type Preflight =
  | { action: "send" }
  | { action: "cancel" }
  | { action: "block" }
  | { action: "defer"; reason: string };

/** 发送前复核（§7.6）：User/身份/Channel/Rule/subject 逐项实时检查。 */
async function preflight(
  delivery: { userId: string; channelId: string; eventId: string },
  now: Date,
): Promise<Preflight> {
  const user = await db.user.findUnique({ where: { id: delivery.userId } });
  if (!user) return { action: "cancel" };
  if (user.status === "suspended") {
    // 只 admin 原因才是终态取消；certus 锁定/禁用等恢复后还要再投（#110）
    if (user.statusReason === "admin") return { action: "cancel" };
    return { action: "defer", reason: "identity_suspended_certus" };
  }

  const gate = await identityGateOk(delivery.userId, now);
  if (!gate.ok) {
    // recoverable identity failure: back to pending, do NOT increment attempts
    return { action: "defer", reason: gate.reason ?? "identity_gate" };
  }

  const channel = await db.notificationChannel.findUnique({
    where: { id: delivery.channelId },
  });
  if (!channel || !channel.enabled) return { action: "cancel" };

  const event = await db.notificationEvent.findUnique({
    where: { id: delivery.eventId },
    include: { rule: { select: { enabled: true } } },
  });
  if (!event || !event.rule.enabled) return { action: "cancel" };

  // subject 仍适用：订阅类提醒的订阅被取消/暂停后不再打扰（#110）
  if (event.subjectType === "subscription") {
    const sub = await db.subscription.findUnique({
      where: { id: event.subjectId },
      select: { status: true },
    });
    if (!sub || (sub.status !== "active" && sub.status !== "trial")) {
      return { action: "cancel" };
    }
  }

  if (channel.type === "email") {
    if (user.emailSyncRequiredAt) {
      return { action: "defer", reason: "email_snapshot_stale" };
    }
    if (!user.emailVerifiedAt) return { action: "block" };
  }
  return { action: "send" };
}

async function attemptSend(
  delivery: { id: string; userId: string; channelId: string; eventId: string },
  now: Date,
): Promise<boolean> {
  try {
    const event = await db.notificationEvent.findUnique({
      where: { id: delivery.eventId },
      include: { rule: { select: { type: true } } },
    });
    if (!event) return false;
    const ruleType = event.rule.type;
    const subject = event.payload as Record<string, unknown>;

    const channel = await db.notificationChannel.findUnique({
      where: { id: delivery.channelId },
    });
    if (!channel) return false;

    if (channel.type === "webhook" && channel.destination) {
      // 设计 §7.6 的 payload 形态：event 是规则类型，subscription 是主体快照
      const body = JSON.stringify({
        id: `evt_${event.id}`,
        event: ruleType,
        occurredAt: event.occurredAt.toISOString(),
        subscription: {
          id: subject?.subscriptionId ?? event.subjectId,
          name: subject?.name ?? null,
          vendor: subject?.vendor ?? null,
        },
        data: subject ?? {},
      });
      return postSafeWebhook(channel.destination, {
        headers: webhookHeaders(`evt_${event.id}`, body, channel.secretCipher, now),
        body,
      });
    }
    if (channel.type === "email") {
      const user = await db.user.findUnique({ where: { id: delivery.userId } });
      if (!user?.email) return false;
      const { sendEmail } = await import("@/server/auth/email-sender");
      const { subject: mailSubject, text } = renderNotificationEmail({
        ruleType,
        payload: subject ?? {},
      });
      await sendEmail({ to: user.email, subject: mailSubject, text });
      return true;
    }
    return false;
  } catch {
    return false;
  }
}
