import { db } from "@/server/db";
import { fetchUserStatus } from "@/server/auth/certus-client-api";
import { loadAuthConfig } from "@/server/auth/config";

/**
 * 可恢复门禁的结构化原因（#116，design §7.6 deferredReason 词汇表）：
 * identity_status_stale / identity_reauth_required / email_snapshot_stale /
 * identity_suspended_certus。identity gate 的内部原因归一到这组稳定词。
 */
export function toDeferredReason(gateReason: string): string {
  switch (gateReason) {
    case "reauth_required":
      return "identity_reauth_required";
    case "identity_status_never_synced":
      return "identity_status_stale";
    default:
      return gateReason;
  }
}

export type CertusEmailPrecheck =
  | { action: "proceed" }
  | { action: "defer"; reason: string }
  | { action: "block" };

/**
 * certus 逐批复核（#116，§7.6）：emailVerificationSource=certus 的用户，每个实际
 * 投递批次发信前必须成功调用 certus 状态端点 —— 失败/429/404 只延迟
 * （fail-closed），不沿用旧结果发送。
 *
 * 响应处理顺序固定（§7.6）：先比较 updated_at —— 快照后有变化则按 §6.2 写
 * emailSyncRequiredAt 并清 certus 来源证明（local 证明不动），本次不得再消费
 * 该响应的验证位；只有版本仍与本地地址快照相容时，email_verified=false/缺失
 * 才表示「已知当前地址未验证」→ blocked。
 */
export async function certusEmailPrecheck(
  user: {
    id: string;
    certusSub: string | null;
    emailVerificationSource: string | null;
    emailSnapshotIssuedAt: Date | null;
  },
  now: Date = new Date(),
): Promise<CertusEmailPrecheck> {
  if (user.emailVerificationSource !== "certus" || !user.certusSub) {
    return { action: "proceed" }; // 本地独立证明无需逐批复核（§7.6 both 模式）
  }

  let status: Awaited<ReturnType<typeof fetchUserStatus>>;
  try {
    status = await fetchUserStatus(loadAuthConfig(), user.certusSub);
  } catch {
    return { action: "defer", reason: "identity_status_stale" };
  }
  if (status.httpStatus === 404) {
    return { action: "defer", reason: "identity_reauth_required" };
  }
  if (status.httpStatus !== 200) {
    return { action: "defer", reason: "identity_status_stale" };
  }

  const updatedAt = status.updatedAt;
  if (updatedAt !== undefined) {
    const snapshotAt = user.emailSnapshotIssuedAt;
    if (snapshotAt === null || updatedAt.getTime() > snapshotAt.getTime()) {
      // 画像在该邮箱快照后有变化：旧地址不得继续投递，等重新登录的成对快照
      await db.user.updateMany({
        where: { id: user.id, emailVerificationSource: "certus" },
        data: {
          emailSyncRequiredAt: now,
          emailVerifiedAt: null,
          emailVerificationSource: null,
        },
      });
      return { action: "defer", reason: "email_snapshot_stale" };
    }
  }

  if (status.emailVerified !== true) {
    return { action: "block" }; // 已知当前地址未验证（终态，不补发）
  }
  return { action: "proceed" };
}
