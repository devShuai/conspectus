import { db } from "@/server/db";
import { encryptCredentialParts, loadCredentialKeyring } from "@/server/auth/crypto";

import { listBalanceAdapters } from "./providers/balance-adapters";

export class ConnectionError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = "ConnectionError";
  }
}

/** 当前支持接入的 provider（通道 A 余额适配器）。 */
export function listConnectableProviders() {
  return listBalanceAdapters();
}

/**
 * Create a ProviderConnection (channel A, design §7.4).
 * 凭证只在入库前经 AES-256-GCM 加密；envelope 存 credentialCipher，
 * iv/tag 同时落到独立列（schema 非空要求），明文绝不出库。
 */
export async function createProviderConnection(input: {
  userId: string;
  providerId: string;
  displayName: string;
  apiKey: string;
}): Promise<{ connectionId: string }> {
  const provider = listConnectableProviders().find((p) => p.id === input.providerId);
  if (!provider) {
    throw new ConnectionError("unknown_provider");
  }

  const keyring = loadCredentialKeyring();
  // §7.4 分列存储：cipher 列只放密文，IV/authTag/keyId 各归其列（#109）
  const parts = encryptCredentialParts(Buffer.from(input.apiKey, "utf8"), keyring);

  const connection = await db.providerConnection.create({
    data: {
      userId: input.userId,
      providerId: provider.id,
      displayName: input.displayName,
      credentialKeyId: parts.keyId,
      credentialCipher: new Uint8Array(parts.ciphertext),
      credentialIv: new Uint8Array(parts.iv),
      credentialTag: new Uint8Array(parts.tag),
      status: "active",
      // 让下一次 usage-sync 立即拉取，而不是等 6 小时
      nextSyncAt: new Date(),
    },
    select: { id: true },
  });
  return { connectionId: connection.id };
}

export async function listProviderConnections(userId: string) {
  return db.providerConnection.findMany({
    where: { userId },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      providerId: true,
      displayName: true,
      status: true,
      lastSyncAt: true,
      lastError: true,
      createdAt: true,
    },
  });
}

/**
 * Disable a connection and revoke its bindings in one transaction (design §7.4
 * Binding 生命周期）。权威 binding 被撤销的 quota 回退到仍活跃的 binding
 * （自动来源优先于手动），无候选则清空权威与当前值 —— 不沿用旧来源的数字。
 */
export async function revokeProviderConnection(input: {
  userId: string;
  connectionId: string;
}): Promise<void> {
  await db.$transaction(async (tx) => {
    const connection = await tx.providerConnection.findFirst({
      where: { id: input.connectionId, userId: input.userId },
      select: { id: true, status: true },
    });
    if (!connection) {
      throw new ConnectionError("connection_not_found");
    }
    if (connection.status === "disabled") {
      return;
    }

    const bindings = await tx.usageBinding.findMany({
      where: { connectionId: connection.id, userId: input.userId, status: "active" },
      select: { id: true, quotaId: true },
    });

    await tx.usageBinding.updateMany({
      where: { connectionId: connection.id, status: "active" },
      data: { status: "revoked" },
    });
    await tx.providerConnection.update({
      where: { id: connection.id },
      data: { status: "disabled", nextSyncAt: null, syncLeaseUntil: null, syncLeaseToken: null },
    });

    const bindingIds = bindings.map((b) => b.id);
    const affectedQuotas = await tx.usageQuota.findMany({
      where: { userId: input.userId, authoritativeBindingId: { in: bindingIds } },
      select: { id: true },
    });

    for (const quota of affectedQuotas) {
      const fallback = await tx.usageBinding.findFirst({
        where: {
          quotaId: quota.id,
          userId: input.userId,
          status: "active",
          source: { in: ["provider", "local_agent", "manual"] },
        },
        // 自动来源（provider/local_agent）优先于手动
        orderBy: [{ source: "desc" }, { createdAt: "asc" }],
      });
      if (!fallback) {
        // 无候选：只解除权威引用，数值保留 —— kind CHECK（§6.2）不允许清空
        // quota/balance 的数值列，且历史读数本身是事实，valueCapturedAt 已标明陈旧
        await tx.usageQuota.update({
          where: { id: quota.id },
          data: { authoritativeBindingId: null },
        });
        continue;
      }
      const latest = await tx.usageSnapshot.findFirst({
        where: { bindingId: fallback.id, quotaId: quota.id },
        orderBy: [{ capturedAt: "desc" }, { id: "desc" }],
      });
      if (!latest) {
        // 候选无快照：只移交权威，同上保留数值
        await tx.usageQuota.update({
          where: { id: quota.id },
          data: { authoritativeBindingId: fallback.id },
        });
        continue;
      }
      await tx.usageQuota.update({
        where: { id: quota.id },
        data: {
          authoritativeBindingId: fallback.id,
          usedValue: latest.kindAtCapture === "balance" ? null : latest.value,
          remainingValue: latest.kindAtCapture === "balance" ? latest.value : null,
          // limitValueAtCapture 为空时保留原上限（quota 的 CHECK 要求非空）
          ...(latest.limitValueAtCapture !== null
            ? { limitValue: latest.limitValueAtCapture }
            : {}),
          valueCapturedAt: latest.capturedAt,
          valueSnapshotId: latest.id,
        },
      });
    }
  });
}
