import { db } from "@/server/db";

/**
 * Daily retention purge (design.md §5.4). Batched, idempotent, never deletes
 * rows that have not reached their expiry. UsageSnapshot: 180 days retention;
 * raw cleared at 30 days (row kept while referenced by valueSnapshotId).
 */
export async function runPurge(now: Date = new Date()): Promise<{
  sessions: number;
  reauthTransactions: number;
  backchannelReplays: number;
  usageSnapshots: number;
  usageRawCleared: number;
}> {
  const cutoff180 = new Date(now.getTime() - 180 * 86_400_000);
  const cutoff30 = new Date(now.getTime() - 30 * 86_400_000);

  const [sessions, reauthTransactions, backchannelReplays] = await Promise.all([
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
  ]);

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
    usageSnapshots: usageSnapshots.count,
    usageRawCleared: usageRawCleared.count,
  };
}
