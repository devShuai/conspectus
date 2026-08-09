import { db } from "@/server/db";

/**
 * Daily retention purge (design.md §5.4). Batched, idempotent, never deletes
 * rows that have not reached their expiry. UsageSnapshot: 180 days retention;
 * raw cleared at 30 days (row kept while referenced by valueSnapshotId).
 * CollectorNonce: 10 分钟保留期（5 分钟签名窗 + 时钟/调度余量）；
 * NotificationDelivery/Digest: 终态（sent/failed/blocked/canceled）超 90 天清理。
 * ImportDraft: 过期 pending 草稿置 expired（行保留，§7.5）；
 * InboundEmail: 到达 rawRetainedUntil 的 rawCipher 置空（行保留，§5.4/§9）。
 */
export async function runPurge(now: Date = new Date()): Promise<{
  sessions: number;
  reauthTransactions: number;
  backchannelReplays: number;
  rateLimitCounters: number;
  passwordResetTokens: number;
  collectorNonces: number;
  notificationDeliveries: number;
  notificationDigests: number;
  usageSnapshots: number;
  usageRawCleared: number;
  importDraftsExpired: number;
  inboundRawCleared: number;
}> {
  const cutoff180 = new Date(now.getTime() - 180 * 86_400_000);
  const cutoff90 = new Date(now.getTime() - 90 * 86_400_000);
  const cutoff30 = new Date(now.getTime() - 30 * 86_400_000);
  const nonceCutoff = new Date(now.getTime() - 10 * 60_000);

  const [
    sessions,
    reauthTransactions,
    backchannelReplays,
    rateLimitCounters,
    passwordResetTokens,
    collectorNonces,
    notificationDeliveries,
    importDraftsExpired,
    inboundRawCleared,
  ] = await Promise.all([
    db.session.deleteMany({
      where: {
        OR: [
          { absoluteExpiresAt: { lt: now } },
          { idleExpiresAt: { lt: now } },
        ],
      },
    }),
    db.reauthTransaction.deleteMany({
      where: {
        OR: [{ expiresAt: { lt: now } }, { consumedAt: { not: null } }],
      },
    }),
    db.backchannelLogoutReplay.deleteMany({
      where: { expiresAt: { lt: now } },
    }),
    db.rateLimitCounter.deleteMany({
      where: { windowEndsAt: { lt: now } },
    }),
    db.passwordResetToken.deleteMany({
      where: { expiresAt: { lt: now } },
    }),
    db.collectorNonce.deleteMany({
      where: { seenAt: { lt: nonceCutoff } },
    }),
    // 终态超 90 天（§7.6：sent/failed/blocked/canceled 均为终态）；须先于
    // Digest 删除，Delivery.digestId 外键引用 Digest
    db.notificationDelivery.deleteMany({
      where: {
        status: { in: ["sent", "failed", "blocked", "canceled"] },
        updatedAt: { lt: cutoff90 },
      },
    }),
    // 过期 pending 草稿置 expired（§5.4）；行保留，终态不误改
    db.importDraft.updateMany({
      where: { status: "pending", expiresAt: { lt: now } },
      data: { status: "expired" },
    }),
    // 到达保留期的邮件原文置空不删行（§5.4/§9：fromAddr/subject 等元数据保留）
    db.inboundEmail.updateMany({
      where: { rawCipher: { not: null }, rawRetainedUntil: { lte: now } },
      data: { rawCipher: null },
    }),
  ]);

  // Digest 终态超 90 天；仍被未到期 Delivery 引用的保留（外键底线）
  const notificationDigests = await db.notificationDigest.deleteMany({
    where: {
      status: { in: ["sent", "failed", "canceled"] },
      updatedAt: { lt: cutoff90 },
      deliveries: { none: {} },
    },
  });

  // Usage snapshots older than 180d, excluding those still referenced as
  // the current value (valueSnapshotId) — those survive until replaced.
  const referenced = await db.usageQuota.findMany({
    where: { valueSnapshotId: { not: null } },
    select: { valueSnapshotId: true },
  });
  const referencedIds = referenced
    .map((q) => q.valueSnapshotId)
    .filter((id): id is string => id !== null);
  const usageSnapshots =
    referencedIds.length > 0
      ? await db.usageSnapshot.deleteMany({
          where: {
            capturedAt: { lt: cutoff180 },
            id: { notIn: referencedIds },
          },
        })
      : await db.usageSnapshot.deleteMany({
          where: { capturedAt: { lt: cutoff180 } },
        });

  // raw cleared after 30 days (kept for provider debugging within window)
  const usageRawCleared = await db.usageSnapshot.updateMany({
    where: { createdAt: { lt: cutoff30 }, raw: { not: null } },
    data: { raw: null },
  });

  return {
    sessions: sessions.count,
    reauthTransactions: reauthTransactions.count,
    backchannelReplays: backchannelReplays.count,
    rateLimitCounters: rateLimitCounters.count,
    passwordResetTokens: passwordResetTokens.count,
    collectorNonces: collectorNonces.count,
    notificationDeliveries: notificationDeliveries.count,
    notificationDigests: notificationDigests.count,
    usageSnapshots: usageSnapshots.count,
    usageRawCleared: usageRawCleared.count,
    importDraftsExpired: importDraftsExpired.count,
    inboundRawCleared: inboundRawCleared.count,
  };
}
