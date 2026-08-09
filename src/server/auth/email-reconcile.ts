import { Prisma } from "@prisma/client";

import { db } from "@/server/db";

/**
 * certus 邮箱快照对账（#125，取代 #116 的 updated_at 启发式）。
 *
 * 旧做法：记下登录时 ID Token 的 iat，之后凡是状态端点的 updated_at 晚于它就
 * 认为「画像可能变过」，清掉验证位并等用户重新登录。方向安全但误报率很高——
 * certus 的 identity.Update 是无条件赋值，管理员改个显示名也会 bump
 * updated_at，于是一次与邮箱无关的编辑就静默停掉了该用户的全部邮件通知。
 *
 * certus#10 之后状态端点成对返回 email + email_verified，可以直接比地址：一致
 * 就按验证位处理，不一致说明用户在 certus 改过地址，采纳新地址与新验证位，不
 * 必再等重新登录。
 */

export type EmailVerdict =
  /** 地址已对上且 certus 说已验证 —— 可以发信。 */
  | "verified"
  /** 地址已对上但未验证，或改址后的新地址未验证 —— 已知不可发（终态）。 */
  | "unverified"
  /** 响应里没有地址，无法成对校验 —— 只能延迟，绝不能沿用本地验证位。 */
  | "unavailable";

export interface EmailReconciliation {
  verdict: EmailVerdict;
  /** 需要写回 User 的字段；无变化时为空对象。 */
  data: Prisma.UserUpdateInput;
}

/**
 * 只处理 emailVerificationSource === "certus" 的用户；本地独立证明由调用方在
 * 外层短路（§7.6 both 模式：certus 状态不得清除用户自己完成的本地验证）。
 */
export function reconcileCertusEmail(
  local: { email: string | null; emailVerifiedAt: Date | null },
  evidence: { email?: string; emailVerified?: boolean },
  now: Date,
): EmailReconciliation {
  if (evidence.email === undefined) {
    // certus 版本早于 e432373，或本客户端的 allowed_scopes 不含 email。
    return { verdict: "unavailable", data: {} };
  }
  const verified = evidence.emailVerified === true;
  const sameAddress =
    local.email !== null && local.email.toLowerCase() === evidence.email.toLowerCase();

  if (!sameAddress) {
    // 用户在 certus 改了地址：整组快照一起换，验证位只能来自本次响应。
    return {
      verdict: verified ? "verified" : "unverified",
      data: {
        email: evidence.email,
        emailVerifiedAt: verified ? now : null,
        emailVerificationSource: verified ? "certus" : null,
      },
    };
  }
  if (!verified) {
    return {
      verdict: "unverified",
      data: { emailVerifiedAt: null, emailVerificationSource: null },
    };
  }
  // 地址一致且已验证：本地已有证明就不必每轮复核都写一次。
  return {
    verdict: "verified",
    data: local.emailVerifiedAt
      ? {}
      : { emailVerifiedAt: now, emailVerificationSource: "certus" },
  };
}

/**
 * 落库。地址是唯一索引，采纳新地址可能撞上另一个账号已占用的地址，此时保持
 * 现状并告知调用方 —— 后台任务不该因为一次改址冲突就中断整批投递。
 *
 * 独立于调用方的事务执行：Postgres 里一条语句失败会毒化整个事务，把它并进状态
 * 同步的事务会让一次邮箱冲突连带回滚掉状态更新。
 */
export async function writeCertusEmail(
  userId: string,
  data: Prisma.UserUpdateInput,
): Promise<"written" | "noop" | "conflict"> {
  if (Object.keys(data).length === 0) return "noop";
  try {
    const result = await db.user.updateMany({
      // 复核期间用户可能刚完成本地验证，那份证明优先，不得被覆盖
      where: { id: userId, emailVerificationSource: "certus" },
      data: data as Prisma.UserUpdateManyMutationInput,
    });
    return result.count > 0 ? "written" : "noop";
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return "conflict";
    }
    throw error;
  }
}
