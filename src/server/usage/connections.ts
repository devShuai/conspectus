import { db } from "@/server/db";
import { encryptCredentialParts, loadCredentialKeyring } from "@/server/auth/crypto";

import { listBalanceAdapters } from "./providers/balance-adapters";
import { getProvider } from "./sync";

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
 * Create a ProviderConnection **and its quota + provider binding** in one
 * transaction（design §7.4 Binding 生命周期：connectProvider 成功时按所选 metric
 * 创建 binding）。余额适配器统一 `metric="credit" / kind="balance"`；
 * quota 找不到就建（balance 的 CHECK 要求 remainingValue 非空，先置 0、首同步覆盖），
 * 首个 binding 成为权威来源（§6.2）。
 */
export async function createProviderConnection(input: {
  userId: string;
  providerId: string;
  displayName: string;
  apiKey: string;
  subscriptionId: string;
  unit: string;
  scopes?: string[];
}): Promise<{ connectionId: string; quotaId: string; bindingId: string }> {
  const provider = getProvider(input.providerId);
  if (!provider) {
    throw new ConnectionError("unknown_provider");
  }
  const subscription = await db.subscription.findFirst({
    where: { id: input.subscriptionId, userId: input.userId },
    select: { id: true },
  });
  if (!subscription) {
    throw new ConnectionError("subscription_not_found");
  }

  const keyring = loadCredentialKeyring();
  // §7.4 分列存储：cipher 列只放密文，IV/authTag/keyId 各归其列（#109）
  const parts = encryptCredentialParts(Buffer.from(input.apiKey, "utf8"), keyring);
  const scopes = input.scopes ?? [];

  return db.$transaction(async (tx) => {
    const quota = await tx.usageQuota.upsert({
      where: { subscriptionId_metric: { subscriptionId: subscription.id, metric: "credit" } },
      create: {
        userId: input.userId,
        subscriptionId: subscription.id,
        kind: "balance",
        metric: "credit",
        unit: input.unit,
        remainingValue: 0, // CHECK 要求非空；nextSyncAt=now，首次同步即覆盖
        resetCycle: "never",
      },
      update: {},
      select: { id: true, authoritativeBindingId: true },
    });

    const connection = await tx.providerConnection.create({
      data: {
        userId: input.userId,
        providerId: provider.id,
        displayName: input.displayName,
        credentialKeyId: parts.keyId,
        credentialCipher: new Uint8Array(parts.ciphertext),
        credentialIv: new Uint8Array(parts.iv),
        credentialTag: new Uint8Array(parts.tag),
        status: "active",
        scopes,
        nextSyncAt: new Date(),
      },
      select: { id: true },
    });

    const binding = await tx.usageBinding.upsert({
      where: {
        quotaId_source_sourceKey: { quotaId: quota.id, source: "provider", sourceKey: "credit" },
      },
      create: {
        userId: input.userId,
        quotaId: quota.id,
        source: "provider",
        sourceKey: "credit",
        connectionId: connection.id,
      },
      // 重新连接同一平台：binding 指向新连接并复活，不另建行
      update: { connectionId: connection.id, status: "active" },
      select: { id: true },
    });

    if (!quota.authoritativeBindingId) {
      await tx.usageQuota.update({
        where: { id: quota.id },
        data: { authoritativeBindingId: binding.id },
      });
    }

    return { connectionId: connection.id, quotaId: quota.id, bindingId: binding.id };
  });
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
        // 自动来源优先于手动（§6.2）：PG 枚举按声明序 manual < provider < local_agent，
        // desc 得 local_agent → provider → manual，两种自动来源都排在 manual 之前
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
