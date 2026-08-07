import { db } from "@/server/db";
import { identityGateOk } from "@/server/auth/identity-status";
import { decryptCredential } from "@/server/auth/crypto";

export const RETRY_STEPS_MS = [60_000, 300_000, 1_800_000];
const MAX_ATTEMPTS = RETRY_STEPS_MS.length;

/**
 * Minute dispatcher: lease due deliveries (SKIP LOCKED semantics via
 * updateMany CAS), verify identity/channel/subject before the call, retry
 * 1m/5m/30m, fail after attempts exhausted. Recoverable identity failures
 * return to pending WITHOUT incrementing attempts.
 */
export async function dispatchDueDeliveries(now: Date = new Date()): Promise<{
  sent: number;
  retried: number;
  failed: number;
  blocked: number;
  canceled: number;
}> {
  let sent = 0;
  let retried = 0;
  let failed = 0;
  let blocked = 0;
  let canceled = 0;

  const due = await db.notificationDelivery.findMany({
    where: {
      AND: [
        { status: { in: ["pending", "sending"] } },
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

    // pre-call checks
    const user = await db.user.findUnique({ where: { id: delivery.userId } });
    if (!user || user.status === "suspended") {
      await db.notificationDelivery.updateMany({
        where: { id: delivery.id, status: "sending", leaseToken },
        data: { status: "canceled", leaseUntil: null, leaseToken: null },
      });
      canceled++;
      continue;
    }
    const gate = await identityGateOk(delivery.userId, now);
    if (!gate.ok) {
      // recoverable identity failure: back to pending, do NOT increment attempts
      await db.notificationDelivery.updateMany({
        where: { id: delivery.id, status: "sending", leaseToken },
        data: {
          status: "pending",
          leaseUntil: null,
          leaseToken: null,
          nextAttemptAt: new Date(now.getTime() + 5 * 60_000),
          lastError: gate.reason ?? "identity_gate",
        },
      });
      continue;
    }
    const channel = await db.notificationChannel.findUnique({
      where: { id: delivery.channelId },
    });
    if (!channel || !channel.enabled) {
      await db.notificationDelivery.updateMany({
        where: { id: delivery.id, status: "sending", leaseToken },
        data: { status: "canceled", leaseUntil: null, leaseToken: null },
      });
      canceled++;
      continue;
    }
    if (channel.type === "email") {
      if (!user.emailVerifiedAt) {
        await db.notificationDelivery.updateMany({
          where: { id: delivery.id, status: "sending", leaseToken },
          data: { status: "blocked", leaseUntil: null, leaseToken: null },
        });
        blocked++;
        continue;
      }
    }

    // attempt the send
    const ok = await attemptSend(delivery.id, delivery.userId, channel, delivery.eventId, now);
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

  return { sent, retried, failed, blocked, canceled };
}

async function attemptSend(
  deliveryId: string,
  userId: string,
  channel: { type: string; destination: string | null; secretCipher: Uint8Array | null },
  eventId: string,
  now: Date,
): Promise<boolean> {
  try {
    const event = await db.notificationEvent.findUnique({ where: { id: eventId } });
    const payload = {
      id: `evt_${eventId}`,
      event: event?.subjectType ?? "unknown",
      occurredAt: event?.occurredAt.toISOString() ?? now.toISOString(),
      data: event?.payload ?? {},
    };
    if (channel.type === "webhook" && channel.destination) {
      const { resolveWebhookTarget } = await import("./webhook-safe");
      const target = await resolveWebhookTarget(channel.destination);
      if (!target) return false;
      const secret = channel.secretCipher
        ? decryptCredential(channel.secretCipher, undefined as never)
        : null;
      const signature = secret
        ? await hmacSha256(secret, JSON.stringify(payload))
        : "unsigned";
      const response = await fetch(target, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-conspectus-event-id": `evt_${eventId}`,
          "x-conspectus-signature": signature,
        },
        body: JSON.stringify(payload),
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      });
      return response.ok;
    }
    if (channel.type === "email") {
      const user = await db.user.findUnique({ where: { id: userId } });
      if (!user?.email) return false;
      const { sendEmail } = await import("@/server/auth/email-sender");
      await sendEmail({
        to: user.email,
        subject: `[conspectus] ${event?.subjectType ?? "通知"}`,
        text: JSON.stringify(payload, null, 2),
      });
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

async function hmacSha256(secret: Uint8Array, message: string): Promise<string> {
  const { createHmac } = await import("node:crypto");
  return createHmac("sha256", secret).update(message).digest("hex");
}
