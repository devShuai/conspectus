import { db } from "@/server/db";
import type { UsageReading } from "./reading.js";
import { IngestError } from "./reading.js";

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
    const snapshot = await tx.usageSnapshot.create({
      data: {
        userId,
        quotaId: quota.id,
        bindingId: binding.id,
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
    });

    // only the authoritative binding updates current value
    if (quota.authoritativeBindingId !== binding.id) {
      return;
    }

    const currentCapturedAt = quota.valueCapturedAt;
    const newer =
      currentCapturedAt === null ||
      capturedAt > currentCapturedAt ||
      (capturedAt.getTime() === currentCapturedAt.getTime() &&
        snapshot.id > (quota.valueSnapshotId ?? ""));
    if (!newer) return;

    await tx.usageQuota.update({
      where: { id: quota.id },
      data: {
        usedValue: reading.usedValue !== undefined ? toDecimal(reading.usedValue) : quota.usedValue,
        remainingValue:
          reading.remainingValue !== undefined
            ? toDecimal(reading.remainingValue)
            : quota.remainingValue,
        limitValue:
          reading.limitValue !== undefined ? toDecimal(reading.limitValue) : quota.limitValue,
        valueCapturedAt: capturedAt,
        valueSnapshotId: snapshot.id,
        lastSyncedAt: now,
        lastSyncStatus: "ok",
        lastSyncError: null,
      },
    });
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
