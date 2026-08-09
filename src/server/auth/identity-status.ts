import { randomUUID } from "node:crypto";

import { db } from "@/server/db";
import { fetchUserStatus, type UserStatusEvidence } from "./certus-client-api";
import type { AuthConfig } from "./config";
import { loadStartupConfig } from "./startup-config";

/** 默认值；实际生效值由 loadStartupConfig 解析 IDENTITY_STATUS_TTL/MAX_STALE 得到（§12.4）。 */
export const IDENTITY_STATUS_TTL_MS = 60 * 60 * 1000;
export const IDENTITY_STATUS_MAX_STALE_MS = 24 * 60 * 60 * 1000;

let cachedLimits: { ttlMs: number; maxStaleMs: number } | null = null;

/**
 * 生效的 TTL / MAX_STALE：来自启动配置（环境变量），配置不可用时回退默认
 * 常量（单测无完整 env 也能跑）。进程内缓存一次，env 运行期不热更新。
 */
export function identityStatusLimits(): { ttlMs: number; maxStaleMs: number } {
  if (cachedLimits) return cachedLimits;
  try {
    const startup = loadStartupConfig();
    cachedLimits = {
      ttlMs: startup.identityStatusTtlMs,
      maxStaleMs: startup.identityStatusMaxStaleMs,
    };
  } catch {
    cachedLimits = {
      ttlMs: IDENTITY_STATUS_TTL_MS,
      maxStaleMs: IDENTITY_STATUS_MAX_STALE_MS,
    };
  }
  return cachedLimits;
}

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
  /** 覆盖每用户复核最小间隔；默认取启动配置 IDENTITY_STATUS_TTL */
  ttlMs?: number;
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

  // TTL 是每用户复核的最小间隔（§6.2/§12.4）：健康用户在 TTL 内已有权威
  // 观测就不再打 certus。失败重试（failureCount>0）与 certus 锁定用户的
  // 恢复复核由 nextStatusCheckAt 调度，不受 TTL 抑制。
  const ttlMs = input.ttlMs ?? identityStatusLimits().ttlMs;
  if (
    user.statusCheckFailureCount === 0 &&
    user.status === "active" &&
    user.lastStatusSyncedAt !== null &&
    now.getTime() - user.lastStatusSyncedAt.getTime() < ttlMs
  ) {
    return { kind: "skip", reason: "fresh_within_ttl" };
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
      outcome = await applyStatus200(user, status, now);
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

/** 身份类可恢复门禁的 deferredReason 集合（§7.6/#116）：恢复事件只唤醒这些行。 */
const IDENTITY_DEFER_REASONS = [
  "identity_suspended_certus",
  "identity_status_stale",
  "identity_reauth_required",
];

async function applyStatus200(
  user: {
    id: string;
    status: string;
    statusReason: string | null;
    emailVerificationSource: string | null;
    emailSnapshotIssuedAt: Date | null;
  },
  evidence: UserStatusEvidence,
  now: Date,
): Promise<IdentityRecheckOutcome> {
  // §6.2 邮箱快照启发式（#116）：任何 200 响应都先比较 updated_at —— 快照后
  // 画像有变化且证明来源是 certus 时，清 certus 证明并写 emailSyncRequiredAt；
  // local 来源的独立证明不得被 certus 状态清除（§7.6 both 模式）。
  const emailSyncData =
    evidence.updatedAt !== undefined &&
    user.emailVerificationSource === "certus" &&
    (user.emailSnapshotIssuedAt === null ||
      evidence.updatedAt.getTime() > user.emailSnapshotIssuedAt.getTime())
      ? {
          emailSyncRequiredAt: now,
          emailVerifiedAt: null,
          emailVerificationSource: null,
        }
      : {};

  if (evidence.status === "locked" || evidence.status === "disabled") {
    const reason =
      evidence.status === "locked" ? "certus_locked" : "certus_disabled";
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
          ...emailSyncData,
        },
      });
      await tx.session.deleteMany({ where: { userId: user.id } });
    });
    return { kind: "suspended", reason };
  }

  // active: clear only certus-caused suspension; never override admin.
  await db.$transaction(async (tx) => {
    await tx.user.update({
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
        ...emailSyncData,
      },
    });
    // §7.6 身份恢复联动（#116）：恢复事件把身份类门禁延迟的 Delivery/Digest
    // 的 nextAttemptAt 推到 now，使其在下一轮 dispatch 立即可投
    const wakeWhere = {
      userId: user.id,
      status: "pending" as const,
      deferredReason: { in: IDENTITY_DEFER_REASONS },
    };
    await tx.notificationDelivery.updateMany({
      where: wakeWhere,
      data: { nextAttemptAt: now },
    });
    await tx.notificationDigest.updateMany({
      where: wakeWhere,
      data: { nextAttemptAt: now },
    });
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
  maxStaleMs: number = identityStatusLimits().maxStaleMs,
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
    if (ageMs > maxStaleMs) {
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
