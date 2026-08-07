import { db } from "@/server/db";
import type { UsageReading } from "./reading";
import { IngestError } from "./reading";

export interface IngestResult {
  accepted: number;
  rejected: Array<{ index: number; reason: string }>;
}

/**
 * Unified ingest for all three channels (design.md §7.4):
 * - every valid reading first appends a Snapshot bound to its binding
 * - only the authoritative binding may update the Quota's current value
 * - Quota update uses (capturedAt, snapshotId) CAS in the same transaction
 * - unknown fields are rejected by Zod .strict() at the boundary
 */
export async function ingestReadings(
  userId: string,
  readings: UsageReading[],
  now: Date = new Date(),
): Promise<IngestResult> {
  const rejected: IngestResult["rejected"] = [];

  for (let index = 0; index < readings.length; index++) {
    const reading = readings[index];
    try {
      await ingestOne(userId, reading, now);
    } catch (cause) {
      rejected.push({
        index,
        reason: cause instanceof IngestError ? cause.reason : "unexpected_error",
      });
    }
  }

  return { accepted: readings.length - rejected.length, rejected };
}

async function ingestOne(userId: string, reading: UsageReading, now: Date): Promise<void> {
  const binding = await db.usageBinding.findUnique({
    where: { id: reading.bindingId },
    include: { quota: true },
  });
  if (!binding || binding.userId !== userId) {
    throw new IngestError("binding_not_found_or_unauthorized");
  }
  if (binding.status !== "active") {
    throw new IngestError("binding_revoked");
  }
  const quota = binding.quota;
  if (quota.kind !== reading.kind) {
    throw new IngestError("kind_mismatch");
  }
  if (reading.unit && quota.unit !== reading.unit) {
    throw new IngestError("unit_mismatch");
  }

  const capturedAt = new Date(reading.capturedAt);
  const value = decimalValue(reading, quota.kind);
  if (value === null) {
    throw new IngestError("missing_value_for_kind");
  }

  await db.$transaction(async (tx) => {
    // Idempotent append: a retried report must reuse the existing snapshot
    // rather than fail, and skipDuplicates maps to ON CONFLICT DO NOTHING so a
    // duplicate cannot abort the transaction (same trap as #65).
    await tx.usageSnapshot.createMany({
      data: [
        {
          userId,
          quotaId: quota.id,
          bindingId: binding.id,
          deviceId: null,
          capturedAt,
          kindAtCapture: quota.kind,
          unitAtCapture: quota.unit,
          value,
          limitValueAtCapture:
            reading.limitValue !== undefined
              ? toDecimal(reading.limitValue)
              : quota.limitValue,
          periodStart:
            reading.periodStart !== undefined
              ? new Date(reading.periodStart)
              : quota.periodStart,
          periodEnd:
            reading.periodEnd !== undefined ? new Date(reading.periodEnd) : quota.periodEnd,
        },
      ],
      skipDuplicates: true,
    });
    const snapshot = await tx.usageSnapshot.findFirst({
      where: { bindingId: binding.id, deviceId: null, capturedAt },
      select: { id: true },
    });
    if (!snapshot) throw new IngestError("snapshot_not_persisted");

    // Only fields the reading actually carries are written; falling back to the
    // values read outside the transaction would let a stale limit overwrite a
    // concurrent change.
    const nextValues: Record<string, unknown> = {
      valueCapturedAt: capturedAt,
      valueSnapshotId: snapshot.id,
      lastSyncedAt: now,
      lastSyncStatus: "ok",
      lastSyncError: null,
    };
    if (reading.usedValue !== undefined) nextValues.usedValue = toDecimal(reading.usedValue);
    if (reading.remainingValue !== undefined) {
      nextValues.remainingValue = toDecimal(reading.remainingValue);
    }
    if (reading.limitValue !== undefined) nextValues.limitValue = toDecimal(reading.limitValue);

    // Database CAS (design §7.4 / R8-USAGE-CAS). Comparing in JS against a
    // quota read *outside* this transaction is check-then-act: two concurrent
    // reports both see the same old valueCapturedAt, both decide "newer", and
    // the later commit wins even when it carries the older reading. Authority
    // is part of the condition for the same reason -- it was read outside too,
    // so an in-flight authority switch must not be overwritten.
    await tx.usageQuota.updateMany({
      where: {
        id: quota.id,
        authoritativeBindingId: binding.id,
        OR: [
          { valueCapturedAt: null },
          { valueCapturedAt: { lt: capturedAt } },
          // deterministic tie-break on identical capturedAt
          { valueCapturedAt: capturedAt, valueSnapshotId: { lt: snapshot.id } },
          { valueCapturedAt: capturedAt, valueSnapshotId: null },
        ],
      },
      data: nextValues,
    });
    // count === 0 is the normal "a newer reading already won" outcome, or this
    // binding is not authoritative: the snapshot is still recorded either way.
  });
}

function decimalValue(reading: UsageReading, kind: string): ReturnType<typeof toDecimal> | null {
  if (kind === "balance") {
    return reading.remainingValue !== undefined ? toDecimal(reading.remainingValue) : null;
  }
  if (kind === "counter") {
    return reading.usedValue !== undefined ? toDecimal(reading.usedValue) : null;
  }
  return reading.usedValue !== undefined ? toDecimal(reading.usedValue) : null;
}

function toDecimal(value: string): string {
  return value; // Prisma accepts decimal strings for Decimal columns
}

export { toDecimal as prismaDecimalFromString };
