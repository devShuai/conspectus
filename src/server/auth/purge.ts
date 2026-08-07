import { db } from "@/server/db";

/**
 * Daily retention purge (design.md §5.4). Batched, idempotent, never deletes
 * rows that have not reached their expiry.
 */
export async function runPurge(now: Date = new Date()): Promise<{
  sessions: number;
  reauthTransactions: number;
  backchannelReplays: number;
}> {
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
        OR: [
          { expiresAt: { lt: now } },
          { consumedAt: { not: null } },
        ],
      },
    }),
    db.backchannelLogoutReplay.deleteMany({
      where: { expiresAt: { lt: now } },
    }),
  ]);
  return {
    sessions: sessions.count,
    reauthTransactions: reauthTransactions.count,
    backchannelReplays: backchannelReplays.count,
  };
}
