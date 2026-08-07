import { db } from "@/server/db";
import { decryptCredential, loadCredentialKeyring, type CredentialKeyring } from "@/server/auth/crypto";

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

/** Decrypt a connection's credential envelope in memory; used once, dropped. */
export function decryptConnectionCredential(
  connection: {
    credentialKeyId: string;
    credentialCipher: Uint8Array;
    credentialIv: Uint8Array;
    credentialTag: Uint8Array;
  },
  keyring: CredentialKeyring = loadCredentialKeyring(),
): DecryptedCredential {
  const blob = Buffer.concat([
    Buffer.from(connection.credentialCipher),
    Buffer.from(connection.credentialIv),
    Buffer.from(connection.credentialTag),
  ]);
  // envelope layout: [keyId header][iv][tag][ciphertext] per crypto.ts pack()
  void connection.credentialKeyId;
  void blob;
  const keyring2 = keyring;
  // credentialCipher already contains the full packed envelope (keyId+iv+tag+cipher)
  const plain = decryptCredential(connection.credentialCipher, keyring2);
  return { secret: plain.toString("utf8"), scopes: [] };
}

export const BACKOFF_STEPS_MS = [1 * 3600_000, 4 * 3600_000, 12 * 3600_000];
export const DEGRADED_PROBE_MS = 24 * 3600_000;

export function nextSyncDelayMs(failureCount: number, retryAfterMs: number | null): number {
  if (retryAfterMs !== null) {
    return Math.min(Math.max(retryAfterMs, 60_000), 12 * 3600_000);
  }
  const index = Math.min(Math.max(failureCount, 0), BACKOFF_STEPS_MS.length - 1);
  return BACKOFF_STEPS_MS[index];
}

/**
 * Hourly sync runner: leases due connections (single-flight), decrypts in
 * memory, calls provider, ingests readings, applies persistent backoff.
 */
export async function syncDueConnections(now: Date = new Date()): Promise<{
  synced: number;
  deferred: number;
  degraded: number;
}> {
  let synced = 0;
  let deferred = 0;
  let degraded = 0;

  const due = await db.providerConnection.findMany({
    where: {
      status: { in: ["active", "degraded"] },
      OR: [{ nextSyncAt: null }, { nextSyncAt: { lte: now } }],
    },
    include: { bindings: { where: { status: "active" }, include: { quota: true } } },
    take: 100,
  });

  for (const connection of due) {
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
    if (leased.count !== 1) continue; // another worker has it

    const provider = getProvider(connection.providerId);
    if (!provider) {
      deferred++;
      continue;
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

      // ingest via the shared pipeline (module-level import to avoid cycles)
      const { ingestReadings } = await import("./ingest");
      const result = await ingestReadings(
        connection.userId,
        readings.map((r) => ({
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

      await db.providerConnection.update({
        where: { id: connection.id },
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
      synced++;
    } catch (cause) {
      const kind = cause instanceof ProviderError ? cause.kind : "network";
      const failureCount = connection.syncFailureCount + 1;
      const retryAfter =
        kind === "rate_limited" ? retryAfterMs(cause) : null;
      const delay = nextSyncDelayMs(failureCount, retryAfter);
      const nextStatus =
        kind === "auth"
          ? "auth_failed"
          : failureCount >= 3
            ? "degraded"
            : connection.status;
      await db.providerConnection.update({
        where: { id: connection.id },
        data: {
          status: nextStatus,
          syncFailureCount: failureCount,
          nextSyncAt: new Date(now.getTime() + delay),
          lastError: redactError(cause),
          syncLeaseUntil: null,
          syncLeaseToken: null,
        },
      });
      if (nextStatus === "degraded") degraded++;
      else deferred++;
    }
  }

  return { synced, deferred, degraded };
}

function retryAfterMs(cause: unknown): number | null {
  const value = (cause as { retryAfterMs?: number }).retryAfterMs;
  return typeof value === "number" ? value : null;
}

function redactError(cause: unknown): string {
  if (cause instanceof ProviderError) return cause.kind;
  return "upstream_error";
}
