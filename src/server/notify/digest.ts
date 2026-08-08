import { db } from "@/server/db";
import { identityGateOk } from "@/server/auth/identity-status";
import { postSafeWebhook } from "./webhook-safe";
import { webhookHeaders } from "./webhook-signing";

export const DIGEST_RETRY_MS = [60_000, 300_000, 1_800_000];
const MAX_ATTEMPTS = DIGEST_RETRY_MS.length + 1; // 与 dispatch 同阶梯：三次重试后才 failed（#110 off-by-one）

/**
 * Digest dispatcher: leases a due Digest batch, renders its still-valid
 * deliveries, sends once, and propagates terminal state to children.
 * Webhook instant and email digest never block each other (separate rows).
 */
export async function dispatchDueDigests(now: Date = new Date()): Promise<{
  sent: number;
  canceled: number;
  retried: number;
  failed: number;
}> {
  let sent = 0;
  let canceled = 0;
  let retried = 0;
  let failed = 0;

  const due = await db.notificationDigest.findMany({
    where: {
      status: { in: ["pending", "sending"] },
      scheduledAt: { lte: now },
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
    },
    take: 20,
  });

  for (const digest of due) {
    const leaseToken = crypto.randomUUID();
    const leased = await db.notificationDigest.updateMany({
      where: {
        id: digest.id,
        status: { in: ["pending", "sending"] },
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
      },
      data: {
        status: "sending",
        leaseUntil: new Date(now.getTime() + 60_000),
        leaseToken,
      },
    });
    if (leased.count !== 1) continue;

    const gate = await identityGateOk(digest.userId, now);
    if (!gate.ok) {
      await db.notificationDigest.updateMany({
        where: { id: digest.id, status: "sending", leaseToken },
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
      where: { id: digest.channelId },
    });
    if (!channel || !channel.enabled) {
      await finalizeDigest(digest.id, leaseToken, "canceled", now);
      // propagate to children
      await db.notificationDelivery.updateMany({
        where: { digestId: digest.id, status: { in: ["pending", "sending"] } },
        data: { status: "canceled" },
      });
      canceled++;
      continue;
    }

    const children = await db.notificationDelivery.findMany({
      where: { digestId: digest.id, status: { in: ["pending", "sending"] } },
    });
    if (children.length === 0) {
      await finalizeDigest(digest.id, leaseToken, "canceled", now);
      canceled++;
      continue;
    }

    // certus email: per-batch status precheck (never fail-open)
    if (channel.type === "email") {
      const user = await db.user.findUnique({ where: { id: digest.userId } });
      if (!user?.emailVerifiedAt || user.emailSyncRequiredAt) {
        await db.notificationDelivery.updateMany({
          where: { digestId: digest.id, status: { in: ["pending", "sending"] } },
          data: { status: "blocked" },
        });
        await finalizeDigest(digest.id, leaseToken, "failed", now);
        blockedOrFailed(digest.id);
        failed++;
        continue;
      }
    }

    const ok = await attemptDigestSend(digest, channel, children, now);
    if (ok) {
      await db.notificationDelivery.updateMany({
        where: { digestId: digest.id, status: { in: ["pending", "sending"] } },
        data: { status: "sent", sentAt: now },
      });
      await finalizeDigest(digest.id, leaseToken, "sent", now);
      sent++;
      continue;
    }

    const attempts = digest.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      await db.notificationDelivery.updateMany({
        where: { digestId: digest.id, status: { in: ["pending", "sending"] } },
        data: { status: "failed" },
      });
      await finalizeDigest(digest.id, leaseToken, "failed", now);
      failed++;
      continue;
    }
    await db.notificationDigest.updateMany({
      where: { id: digest.id, status: "sending", leaseToken },
      data: {
        status: "pending",
        attempts,
        nextAttemptAt: new Date(now.getTime() + DIGEST_RETRY_MS[attempts - 1]),
        leaseUntil: null,
        leaseToken: null,
      },
    });
    retried++;
  }

  return { sent, canceled, retried, failed };
}

function blockedOrFailed(_digestId: string): void {
  // counter helper kept minimal
}

async function finalizeDigest(
  digestId: string,
  leaseToken: string,
  status: "sent" | "failed" | "canceled",
  now: Date,
): Promise<void> {
  await db.notificationDigest.updateMany({
    where: { id: digestId, status: "sending", leaseToken },
    data: { status, sentAt: status === "sent" ? now : null, leaseUntil: null, leaseToken: null },
  });
}

async function attemptDigestSend(
  digest: { id: string; userId: string },
  channel: { type: string; destination: string | null; secretCipher: Uint8Array | null },
  children: Array<{ eventId: string }>,
  now: Date,
): Promise<boolean> {
  try {
    const events = await db.notificationEvent.findMany({
      where: { id: { in: children.map((c) => c.eventId) } },
    });
    const payload = {
      id: `digest_${digest.id}`,
      event: "daily_digest",
      occurredAt: now.toISOString(),
      items: events.map((e) => e.payload),
    };
    if (channel.type === "email") {
      const user = await db.user.findUnique({ where: { id: digest.userId } });
      if (!user?.email) return false;
      const { sendEmail } = await import("@/server/auth/email-sender");
      await sendEmail({
        to: user.email,
        subject: "[conspectus] 每日摘要",
        text: JSON.stringify(payload, null, 2),
      });
      return true;
    }
    if (channel.type === "webhook" && channel.destination) {
      const body = JSON.stringify(payload);
      return postSafeWebhook(channel.destination, {
        headers: webhookHeaders(
          `digest_${digest.id}`,
          body,
          channel.secretCipher,
        ),
        body,
      });
    }
    return false;
  } catch {
    return false;
  }
}
