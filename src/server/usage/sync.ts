import { db } from "@/server/db";
import type { Prisma } from "@prisma/client";
import { decryptCredentialParts, loadCredentialKeyring, type CredentialKeyring } from "@/server/auth/crypto";

export interface SyncContext {
  userId: string;
  connectionId: string;
  /** bindings this provider is allowed to write (server-side truth). */
  allowedBindings: Array<{ bindingId: string; metric: string; kind: string; unit: string }>;
}

export interface DecryptedCredential {
  /** never logged, never returned to client */
  secret: string;
  scopes: string[];
}

export interface UsageReadingLike {
  bindingId: string;
  kind: "quota" | "balance" | "counter";
  metric: string;
  unit: string;
  usedValue?: string;
  limitValue?: string;
  remainingValue?: string;
  periodStart?: string;
  periodEnd?: string;
  capturedAt: string;
  raw?: unknown;
}

export interface UsageProvider {
  id: string;
  displayName: string;
  authKind: "api_key" | "oauth" | "none";
  fetchUsage(
    cred: DecryptedCredential,
    ctx: SyncContext,
  ): Promise<UsageReadingLike[]>;
}

export class ProviderError extends Error {
  constructor(
    public readonly kind: "auth" | "rate_limited" | "network" | "invalid",
    message: string,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

const registry = new Map<string, UsageProvider>();

export function registerProvider(provider: UsageProvider): void {
  registry.set(provider.id, provider);
}

export function getProvider(id: string): UsageProvider | undefined {
  return registry.get(id);
}

export function listProviders(): UsageProvider[] {
  return [...registry.values()];
}

/** Decrypt a connection's credential from its columns in memory; used once, dropped. */
export function decryptConnectionCredential(
  connection: {
    credentialKeyId: string;
    credentialCipher: Uint8Array;
    credentialIv: Uint8Array;
    credentialTag: Uint8Array;
    scopes: string[];
  },
  keyring: CredentialKeyring = loadCredentialKeyring(),
): DecryptedCredential {
  // §7.4：密文、IV、authTag、keyId 分列存储（#109）
  const plain = decryptCredentialParts(
    {
      keyId: connection.credentialKeyId,
      ciphertext: connection.credentialCipher,
      iv: connection.credentialIv,
      tag: connection.credentialTag,
    },
    keyring,
  );
  return { secret: plain.toString("utf8"), scopes: [...connection.scopes] };
}

export const BACKOFF_STEPS_MS = [1 * 3600_000, 4 * 3600_000, 12 * 3600_000];
export const DEGRADED_PROBE_MS = 24 * 3600_000;
const MAX_CONCURRENT_SYNCS = 5;

export function nextSyncDelayMs(failureCount: number, retryAfterMs: number | null): number {
  if (retryAfterMs !== null) {
    return Math.min(Math.max(retryAfterMs, 60_000), 12 * 3600_000);
  }
  const index = Math.min(Math.max(failureCount, 0), BACKOFF_STEPS_MS.length - 1);
  return BACKOFF_STEPS_MS[index];
}

/** 三次重试（1h/4h/12h）仍失败 → degraded，之后每 24h 探测一次（§7.4 / #107）。
 * failureCount 为已失败次数（≥1）：第 1 次失败等 1h，第 2 次 4h，第 3 次进 degraded。 */
export function syncDelayForFailure(failureCount: number, retryAfterMs: number | null): number {
  if (failureCount >= 3) return DEGRADED_PROBE_MS;
  return nextSyncDelayMs(failureCount - 1, retryAfterMs);
}

/**
 * Hourly sync runner: leases due connections (single-flight), decrypts in
 * memory, calls provider, ingests readings, applies persistent backoff.
 * 并发 5（§7.4）；完成回写必须匹配租约 token，过期 worker 不得覆盖新结果。
 */
export async function syncDueConnections(
  now: Date = new Date(),
  options: {
    /** `?shard=k&of=n` 分片（§7.4，Serverless 时长上限时多次调度） */
    shard?: { index: number; of: number };
    shardIndex?: (userId: string, of: number) => number;
  } = {},
): Promise<{
  synced: number;
  deferred: number;
  degraded: number;
}> {
  const candidates = await db.providerConnection.findMany({
    where: {
      status: { in: ["active", "degraded"] },
      OR: [{ nextSyncAt: null }, { nextSyncAt: { lte: now } }],
    },
    include: { bindings: { where: { status: "active" }, include: { quota: true } } },
    take: 100,
  });
  const due = options.shard
    ? candidates.filter(
        (c) => options.shardIndex?.(c.userId, options.shard!.of) === options.shard!.index,
      )
    : candidates;

  const outcomes = await mapWithConcurrency(due, MAX_CONCURRENT_SYNCS, (connection) =>
    syncOne(connection, now),
  );
  return {
    synced: outcomes.filter((o) => o === "synced").length,
    deferred: outcomes.filter((o) => o === "deferred").length,
    degraded: outcomes.filter((o) => o === "degraded").length,
  };
}

type SyncConnection = Prisma.ProviderConnectionGetPayload<{
  include: { bindings: { include: { quota: true } } };
}>;

type SyncOutcome = "synced" | "deferred" | "degraded" | "skipped";

async function syncOne(connection: SyncConnection, now: Date): Promise<SyncOutcome> {
  const leaseToken = crypto.randomUUID();
  const leased = await db.providerConnection.updateMany({
    where: {
      id: connection.id,
      OR: [{ syncLeaseUntil: null }, { syncLeaseUntil: { lte: now } }],
    },
    data: {
      syncLeaseUntil: new Date(now.getTime() + 60_000),
      syncLeaseToken: leaseToken,
    },
  });
  if (leased.count !== 1) return "skipped"; // another worker has it

  const provider = getProvider(connection.providerId);
  if (!provider) {
    await db.providerConnection.updateMany({
      where: { id: connection.id, syncLeaseToken: leaseToken },
      data: { syncLeaseUntil: null, syncLeaseToken: null },
    });
    return "deferred";
  }

  try {
    const cred = decryptConnectionCredential(connection);
    const ctx: SyncContext = {
      userId: connection.userId,
      connectionId: connection.id,
      allowedBindings: connection.bindings.map((b) => ({
        bindingId: b.id,
        metric: b.quota.metric,
        kind: b.quota.kind,
        unit: b.quota.unit,
      })),
    };
    const readings = await provider.fetchUsage(cred, ctx);

    // 逐条校验 bindingId 归属该 connection（§7.4：适配器必须从 allowedBindings
    // 选择，服务端复核 —— 同用户其他 connection 的 binding 不得写入）
    const allowed = new Set(connection.bindings.map((b) => b.id));
    const accepted = readings.filter((r) => allowed.has(r.bindingId));

    // ingest via the shared pipeline (module-level import to avoid cycles)
    const { ingestReadings } = await import("./ingest");
    await ingestReadings(
      connection.userId,
      accepted.map((r) => ({
        bindingId: r.bindingId,
        kind: r.kind,
        metric: r.metric,
        unit: r.unit,
        usedValue: r.usedValue,
        limitValue: r.limitValue,
        remainingValue: r.remainingValue,
        periodStart: r.periodStart,
        periodEnd: r.periodEnd,
        capturedAt: r.capturedAt,
      })),
      now,
    );

    // 回写必须匹配租约 token：过期 worker 不得覆盖新结果（§7.4 / #107）
    const completed = await db.providerConnection.updateMany({
      where: { id: connection.id, syncLeaseToken: leaseToken },
      data: {
        status: "active",
        lastSyncAt: now,
        syncFailureCount: 0,
        nextSyncAt: new Date(now.getTime() + 6 * 3600_000),
        lastError: null,
        syncLeaseUntil: null,
        syncLeaseToken: null,
      },
    });
    if (completed.count === 1 && (connection.status === "auth_failed" || connection.status === "degraded")) {
      // 连接恢复 ok 后清除 connection_failed 武装（§7.6 / #114）
      const { clearConnectionFailure } = await import("../notify/usage-rules");
      await clearConnectionFailure({
        userId: connection.userId,
        connectionId: connection.id,
        now,
      });
    }
    return completed.count === 1 ? "synced" : "skipped";
  } catch (cause) {
    const kind = cause instanceof ProviderError ? cause.kind : "network";
    const failureCount = connection.syncFailureCount + 1;
    const retryAfter = kind === "rate_limited" ? retryAfterMs(cause) : null;
    const delay = syncDelayForFailure(failureCount, retryAfter);
    const nextStatus =
      kind === "auth"
        ? "auth_failed"
        : failureCount >= 3
          ? "degraded"
          : connection.status;
    const written = await db.providerConnection.updateMany({
      where: { id: connection.id, syncLeaseToken: leaseToken },
      data: {
        status: nextStatus,
        syncFailureCount: failureCount,
        nextSyncAt: new Date(now.getTime() + delay),
        lastError: redactError(cause),
        syncLeaseUntil: null,
        syncLeaseToken: null,
      },
    });
    if (written.count !== 1) return "skipped";
    if (nextStatus === "auth_failed" || nextStatus === "degraded") {
      // 连接转入失败态 → connection_failed 求值（§7.6 / #114）
      const { notifyConnectionFailed } = await import("../notify/usage-rules");
      await notifyConnectionFailed({
        userId: connection.userId,
        connectionId: connection.id,
        displayName: connection.displayName,
        status: nextStatus,
        now,
      });
    }
    return nextStatus === "degraded" ? "degraded" : "deferred";
  }
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index]);
    }
  }
  const lanes = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: lanes }, () => worker()));
  return results;
}

function retryAfterMs(cause: unknown): number | null {
  const value = (cause as { retryAfterMs?: number }).retryAfterMs;
  return typeof value === "number" ? value : null;
}

function redactError(cause: unknown): string {
  if (cause instanceof ProviderError) return cause.kind;
  return "upstream_error";
}
