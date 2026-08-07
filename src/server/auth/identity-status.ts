import { randomUUID } from "node:crypto";

import { db } from "@/server/db";
import { fetchUserStatus } from "./certus-client-api.js";
import type { AuthConfig } from "./config.js";

export const IDENTITY_STATUS_TTL_MS = 60 * 60 * 1000;
export const IDENTITY_STATUS_MAX_STALE_MS = 24 * 60 * 60 * 1000;

const BACKOFF_STEPS_MS = [5 * 60 * 1000, 15 * 60 * 1000, 60 * 60 * 1000];
const MAX_BACKOFF_INDEX = BACKOFF_STEPS_MS.length - 1;

export type IdentityRecheckOutcome =
  | { kind: "active" }
  | { kind: "suspended"; reason: "certus_locked" | "certus_disabled" }
  | { kind: "reauth_required" }
  | { kind: "deferred"; nextCheckAt: Date; reason: string }
  | { kind: "skip"; reason: string };

export interface IdentityRecheckInput {
  userId: string;
  certusSub: string;
  config: AuthConfig;
  now?: Date;
}

/**
 * Per-user single-flight lease CAS. Never holds a DB transaction across the
 * upstream HTTP call: lease is taken in its own short transaction, released /
 * finalized afterwards.
 */
async function acquireStatusLease(
  userId: string,
  now: Date,
  tx: Parameters<Parameters<typeof db.$transaction>[0]>[0],
): Promise<string | null> {
  const token = randomUUID();
  const updated = await tx.user.updateMany({
    where: {
      id: userId,
      OR: [{ statusSyncLeaseUntil: null }, { statusSyncLeaseUntil: { lte: now } }],
    },
    data: {
      statusSyncLeaseUntil: new Date(now.getTime() + 60_000),
      statusSyncLeaseToken: token,
    },
  });
  return updated.count === 1 ? token : null;
}

async function releaseStatusLease(
  userId: string,
  leaseToken: string,
  tx: Parameters<Parameters<typeof db.$transaction>[0]>[0],
): Promise<void> {
  await tx.user.updateMany({
    where: { id: userId, statusSyncLeaseToken: leaseToken },
    data: { statusSyncLeaseUntil: null, statusSyncLeaseToken: null },
  });
}

function backoffDelayMs(failureCount: number, retryAfterMs: number | null): number {
  if (retryAfterMs !== null) {
    return Math.min(retryAfterMs, 60 * 60 * 1000);
  }
  const index = Math.min(Math.max(failureCount, 0), MAX_BACKOFF_INDEX);
  const base = BACKOFF_STEPS_MS[index];
  const jitter = Math.floor(Math.random() * base * 0.1);
  return base + jitter;
}

/**
 * Recheck one user's certus identity status and apply the three-layer state
 * machine (design.md §6.2). Returns an outcome suitable for logs/metrics.
 */
export async function recheckIdentityStatus(
  input: IdentityRecheckInput,
): Promise<IdentityRecheckOutcome> {
  const now = input.now ?? new Date();

  // Fail-closed: never treat NULL lastStatusSyncedAt as "fresh".
  const user = await db.user.findUnique({ where: { id: input.userId } });
  if (!user || user.certusSub !== input.certusSub || user.certusSub === null) {
    return { kind: "skip", reason: "user_not_certus" };
  }

  const lease = await db.$transaction(async (tx) =>
    acquireStatusLease(input.userId, now, tx),
  );
  if (lease === null) {
    return { kind: "skip", reason: "lease_busy" };
  }

  let outcome: IdentityRecheckOutcome;
  try {
    const status = await fetchUserStatus(input.config, user.certusSub);

    if (status.httpStatus === 200) {
      outcome = await applyStatus200(user, status.status, now);
    } else if (status.httpStatus === 404) {
      outcome = await applyStatus404(user, now);
    } else {
      // 429 / 5xx / network: schedule retry, keep last known state usable if fresh.
      const retryAfterMs = parseRetryAfterMs(status.retryAfter);
      const nextCheckAt = new Date(
        now.getTime() + backoffDelayMs(user.statusCheckFailureCount, retryAfterMs),
      );
      await db.user.update({
        where: { id: user.id },
        data: {
          statusCheckFailureCount: user.statusCheckFailureCount + 1,
          nextStatusCheckAt: nextCheckAt,
          lastStatusSyncError: redactError(status.httpStatus),
        },
      });
      outcome = { kind: "deferred", nextCheckAt, reason: `http_${status.httpStatus}` };
    }
  } catch (cause) {
    const nextCheckAt = new Date(
      now.getTime() + backoffDelayMs(user.statusCheckFailureCount, null),
    );
    await db.user.update({
      where: { id: user.id },
      data: {
        statusCheckFailureCount: user.statusCheckFailureCount + 1,
        nextStatusCheckAt: nextCheckAt,
        lastStatusSyncError: "network_or_upstream_failure",
      },
    });
    outcome = {
      kind: "deferred",
      nextCheckAt,
      reason: cause instanceof Error ? cause.name : "unknown",
    };
  } finally {
    await db.$transaction(async (tx) => releaseStatusLease(user.id, lease, tx));
  }

  return outcome;
}

async function applyStatus200(
  user: { id: string; status: string; statusReason: string | null },
  upstreamStatus: string | undefined,
  now: Date,
): Promise<IdentityRecheckOutcome> {
  if (upstreamStatus === "locked" || upstreamStatus === "disabled") {
    const reason =
      upstreamStatus === "locked" ? "certus_locked" : "certus_disabled";
    await db.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: {
          status: "suspended",
          statusReason: reason,
          certusLinkStatus: "active",
          lastStatusSyncedAt: now,
          statusCheckFailureCount: 0,
          nextStatusCheckAt: null,
          lastStatusSyncError: null,
        },
      });
      await tx.session.deleteMany({ where: { userId: user.id } });
    });
    return { kind: "suspended", reason };
  }

  // active: clear only certus-caused suspension; never override admin.
  await db.user.update({
    where: { id: user.id },
    data: {
      status: user.status === "suspended" && user.statusReason === "admin" ? "suspended" : "active",
      statusReason:
        user.status === "suspended" && user.statusReason === "admin"
          ? "admin"
          : null,
      certusLinkStatus: "active",
      lastStatusSyncedAt: now,
      statusCheckFailureCount: 0,
      nextStatusCheckAt: null,
      lastStatusSyncError: null,
    },
  });
  return { kind: "active" };
}

async function applyStatus404(
  user: { id: string },
  now: Date,
): Promise<IdentityRecheckOutcome> {
  await db.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: user.id },
      data: {
        certusLinkStatus: "reauth_required",
        lastStatusSyncedAt: now,
        statusCheckFailureCount: 0,
        nextStatusCheckAt: null,
        lastStatusSyncError: null,
      },
    });
    await tx.session.deleteMany({
      where: { userId: user.id, authMethod: "certus" },
    });
  });
  return { kind: "reauth_required" };
}

/** Identity gate for M3 callers: may this user's outbound actions proceed? */
export async function identityGateOk(
  userId: string,
  now: Date = new Date(),
): Promise<{ ok: boolean; reason?: string }> {
  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user) return { ok: false, reason: "user_not_found" };
  if (user.status === "suspended") {
    return { ok: false, reason: `suspended:${user.statusReason ?? "unknown"}` };
  }
  if (user.certusLinkStatus === "reauth_required") {
    return { ok: false, reason: "reauth_required" };
  }
  if (user.certusSub !== null && user.lastStatusSyncedAt === null) {
    return { ok: false, reason: "identity_status_never_synced" };
  }
  if (user.certusSub !== null) {
    const ageMs = now.getTime() - user.lastStatusSyncedAt!.getTime();
    if (ageMs > IDENTITY_STATUS_MAX_STALE_MS) {
      return { ok: false, reason: "identity_status_stale" };
    }
  }
  return { ok: true };
}

function parseRetryAfterMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = new Date(value);
  if (!Number.isNaN(date.getTime())) return Math.max(0, date.getTime() - Date.now());
  return null;
}

function redactError(httpStatus: number): string {
  return `http_${httpStatus}`;
}
