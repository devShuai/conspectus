import { fetchUserStatus } from "@/server/auth/certus-client-api";
import { loadAuthConfig } from "@/server/auth/config";
import { reconcileCertusEmail, writeCertusEmail } from "@/server/auth/email-reconcile";

/**
 * 可恢复门禁的结构化原因（design §7.6 deferredReason 词汇表）：
 * identity_status_stale / identity_reauth_required / identity_email_unavailable /
 * identity_email_conflict / identity_suspended_certus。identity gate 的内部原因
 * 归一到这组稳定词。（email_snapshot_stale 随 #125 的启发式一并移除。）
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
 * certus 逐批复核（§7.6）：emailVerificationSource=certus 的用户，每个实际投递
 * 批次发信前必须成功调用 certus 状态端点 —— 失败/429/404 只延迟（fail-closed），
 * 不沿用旧结果发送。
 *
 * 响应里的 email 与 email_verified 成对使用（certus#10）：地址一致时验证位才
 * 说的是本地这个地址；不一致说明用户在 certus 改过，采纳新地址与新验证位。
 * 地址缺失（certus 过旧或客户端无 email scope）同样 fail-closed。
 */
export async function certusEmailPrecheck(
  user: {
    id: string;
    certusSub: string | null;
    email: string | null;
    emailVerifiedAt: Date | null;
    emailVerificationSource: string | null;
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

  const { verdict, data } = reconcileCertusEmail(user, status, now);
  if (verdict === "unavailable") {
    // 拿不到地址就无法判断验证位说的是不是本地这个地址，只能等
    return { action: "defer", reason: "identity_email_unavailable" };
  }
  if ((await writeCertusEmail(user.id, data)) === "conflict") {
    // 新地址已属于另一个账号；保持现状，等人工或下次登录解决
    return { action: "defer", reason: "identity_email_conflict" };
  }
  if (verdict === "unverified") {
    return { action: "block" }; // 已知当前地址未验证（终态，不补发）
  }
  return { action: "proceed" };
}
