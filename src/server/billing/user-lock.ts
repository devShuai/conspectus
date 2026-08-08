import type { Prisma } from "@prisma/client";

/**
 * 用户级事务锁（design §6.2 本位币重算与入账的并发 / #108）：
 * paid 入账（recordPaidCharge/recordRefund/confirmPendingCharge）与 rebase
 * 消费者共用同一把锁——直接锁定 users 行（等价于 pg_advisory_xact_lock(userId)，
 * 行必然存在且随事务释放）。所有调用方都先取这把锁再写，加锁顺序一致，
 * 不会引入新的死锁边。
 */
export async function lockUserInTx(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT id FROM "users" WHERE id = ${userId}::uuid FOR UPDATE`;
}
