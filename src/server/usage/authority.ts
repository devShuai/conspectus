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
      await tx.usageQuota.update({
        where: { id: quota.id },
        data: {
          authoritativeBindingId: binding.id,
          usedValue: null,
          remainingValue: null,
          limitValue: null,
          valueCapturedAt: null,
          valueSnapshotId: null,
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
        limitValue: latest.limitValueAtCapture,
        valueCapturedAt: latest.capturedAt,
        valueSnapshotId: latest.id,
        lastSyncedAt: now,
      },
    });
  });
}
