import { db } from "@/server/db";
import { identityGateOk } from "@/server/auth/identity-status";
import { postSafeWebhook } from "./webhook-safe";
import { webhookHeaders } from "./webhook-signing";

export const DIGEST_RETRY_MS = [60_000, 300_000, 1_800_000];
const MAX_ATTEMPTS = DIGEST_RETRY_MS.length + 1; // 与 dispatch 同阶梯：三次重试后才 failed（#110 off-by-one）

const DEFER_MS = 5 * 60_000;

/**
 * Digest dispatcher: leases a due Digest batch, renders its still-valid
 * deliveries, sends once, and propagates terminal state to children.
 * Webhook instant and email digest never block each other (separate rows).
 *
 * #91 终态对齐 §7.6：已知邮箱未验证 → Digest 与子 Delivery 一并 blocked（不再
 * 落 failed）；可恢复门禁（身份/邮箱快照）释放租约回 pending、不消耗外呼
 * attempts；Digest 终态与子 Delivery 终态的写入在同一事务。
 */
export async function dispatchDueDigests(now: Date = new Date()): Promise<{
  sent: number;
  canceled: number;
  retried: number;
  failed: number;
  blocked: number;
  deferred: number;
}> {
  let sent = 0;
  let canceled = 0;
  let retried = 0;
  let failed = 0;
  let blocked = 0;
  let deferred = 0;

  const due = await db.notificationDigest.findMany({
    where: {
      status: { in: ["pending", "sending"] },
      scheduledAt: { lte: now },
      AND: [
        { OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }] },
        { OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
      ],
    },
    take: 20,
  });

  for (const digest of due) {
    const leaseToken = crypto.randomUUID();
    // 与 dispatch.ts 同形的租约 CAS（§7.6）：pending 到期件 + 过期的 sending
    // 租约；不再无条件覆盖其他 worker 持有的 sending 租约（原实现可能双发）
    const leased = await db.notificationDigest.updateMany({
      where: {
        id: digest.id,
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

    // ---- 发送前复核（§7.6）：User 全局状态 → identity gate → 渠道 → 邮箱快照 ----
    const user = await db.user.findUnique({ where: { id: digest.userId } });
    if (!user) {
      await finalizeDigest(digest.id, leaseToken, "canceled", now);
      canceled++;
      continue;
    }
    if (user.status === "suspended") {
      // 与 direct 一致：只有 admin 原因才终态取消，certus 锁定/禁用等恢复后再投
      if (user.statusReason === "admin") {
        await finalizeDigest(digest.id, leaseToken, "canceled", now);
        canceled++;
      } else {
        await deferDigest(digest.id, leaseToken, "identity_suspended_certus", now);
        deferred++;
      }
      continue;
    }

    const gate = await identityGateOk(digest.userId, now);
    if (!gate.ok) {
      await deferDigest(digest.id, leaseToken, gate.reason ?? "identity_gate", now);
      deferred++;
      continue;
    }

    const channel = await db.notificationChannel.findUnique({
      where: { id: digest.channelId },
    });
    if (!channel || !channel.enabled) {
      await finalizeDigest(digest.id, leaseToken, "canceled", now);
      canceled++;
      continue;
    }

    const children = await db.notificationDelivery.findMany({
      where: { digestId: digest.id, status: { in: ["pending", "sending"] } },
    });
    if (children.length === 0) {
      // 没有有效条目：批次取消（§7.6）
      await finalizeDigest(digest.id, leaseToken, "canceled", now);
      canceled++;
      continue;
    }

    if (channel.type === "email") {
      if (user.emailSyncRequiredAt) {
        // 邮箱快照待刷新是可恢复门禁：回 pending 延迟，不是 blocked（#91）
        await deferDigest(digest.id, leaseToken, "email_snapshot_stale", now);
        deferred++;
        continue;
      }
      if (!user.emailVerifiedAt) {
        // 已知未验证：Digest 与子 Delivery 一并 blocked（终态，不补发）
        await finalizeDigest(digest.id, leaseToken, "blocked", now);
        blocked++;
        continue;
      }
    }

    const ok = await attemptDigestSend(digest, channel, children, now);
    if (ok) {
      await finalizeDigest(digest.id, leaseToken, "sent", now);
      sent++;
      continue;
    }

    const attempts = digest.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
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
        lastError: "delivery_failed",
      },
    });
    retried++;
  }

  return { sent, canceled, retried, failed, blocked, deferred };
}

/** 可恢复门禁：释放租约回 pending 并安排重试，不消耗外呼 attempts（§7.6）。 */
async function deferDigest(
  digestId: string,
  leaseToken: string,
  reason: string,
  now: Date,
): Promise<void> {
  await db.notificationDigest.updateMany({
    where: { id: digestId, status: "sending", leaseToken },
    data: {
      status: "pending",
      leaseUntil: null,
      leaseToken: null,
      nextAttemptAt: new Date(now.getTime() + DEFER_MS),
      lastError: reason,
    },
  });
}

/**
 * Digest 进入终态时，同事务把尚未终态的子 Delivery 置为对应终态（§7.6）；
 * sent 标记的正是本次渲染的 pending/sending 子项（迟到事件由 upsertDigestBatch
 * 顺延到下一批次，不会混入发送中的批次）。
 */
async function finalizeDigest(
  digestId: string,
  leaseToken: string,
  status: "sent" | "failed" | "blocked" | "canceled",
  now: Date,
): Promise<void> {
  await db.$transaction(async (tx) => {
    await tx.notificationDelivery.updateMany({
      where: { digestId, status: { in: ["pending", "sending"] } },
      data:
        status === "sent"
          ? { status: "sent", sentAt: now }
          : { status },
    });
    await tx.notificationDigest.updateMany({
      where: { id: digestId, status: "sending", leaseToken },
      data: {
        status,
        sentAt: status === "sent" ? now : null,
        leaseUntil: null,
        leaseToken: null,
      },
    });
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
