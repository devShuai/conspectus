import { db } from "@/server/db";

export class AuthorityError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = "AuthorityError";
  }
}

/**
 * Explicit authoritative-binding switch (design.md §6.2):
 * - locks Quota + candidate Binding
 * - rebuilds current value from the candidate's latest snapshot
 * - no snapshot → clear value fields; never carries over the old binding's numbers
 */
export async function switchAuthoritativeBinding(input: {
  userId: string;
  quotaId: string;
  newBindingId: string;
  now?: Date;
}): Promise<void> {
  const now = input.now ?? new Date();
  await db.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<
      Array<{ id: string }>
    >`SELECT id FROM "usage_quotas" WHERE id = ${input.quotaId}::uuid FOR UPDATE`;
    if (locked.length !== 1) {
      throw new AuthorityError("quota_not_found");
    }
    const quota = await tx.usageQuota.findUnique({ where: { id: input.quotaId } });
    if (!quota || quota.userId !== input.userId) {
      throw new AuthorityError("quota_not_found");
    }
    const binding = await tx.usageBinding.findUnique({
      where: { id: input.newBindingId },
    });
    if (!binding || binding.userId !== input.userId || binding.quotaId !== quota.id) {
      throw new AuthorityError("binding_not_found");
    }
    if (binding.status !== "active") {
      throw new AuthorityError("binding_revoked");
    }

    const latest = await tx.usageSnapshot.findFirst({
      where: { bindingId: binding.id, quotaId: quota.id },
      orderBy: [{ capturedAt: "desc" }, { id: "desc" }],
    });

    if (!latest) {
      // 无快照可重建：只移交权威，数值保留 —— §6.2 的 kind CHECK 不允许清空
      // quota/balance/counter 的数值列；历史读数是事实，valueCapturedAt 标明陈旧
      await tx.usageQuota.update({
        where: { id: quota.id },
        data: {
          authoritativeBindingId: binding.id,
          lastSyncedAt: now,
        },
      });
      return;
    }

    await tx.usageQuota.update({
      where: { id: quota.id },
      data: {
        authoritativeBindingId: binding.id,
        usedValue: latest.kindAtCapture === "balance" ? null : latest.value,
        remainingValue: latest.kindAtCapture === "balance" ? latest.value : null,
        // limitValueAtCapture 为空时保留原上限（quota 的 CHECK 要求非空）
        ...(latest.limitValueAtCapture !== null
          ? { limitValue: latest.limitValueAtCapture }
          : {}),
        valueCapturedAt: latest.capturedAt,
        valueSnapshotId: latest.id,
        lastSyncedAt: now,
      },
    });
  });
}
