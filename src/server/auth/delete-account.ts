import { db } from "@/server/db";

import { consumeReauthTransaction } from "./reauth";

export class DeleteAccountError extends Error {
  constructor(
    public readonly code:
      | "user_not_found"
      | "email_mismatch"
      | "reauth_required"
      | "reauth_invalid",
  ) {
    super(code);
    this.name = "DeleteAccountError";
  }
}

/**
 * 注销账号并级联硬删除（design §8/§9 / #113）：
 * - 需重新认证（§7.1）：action=delete_account 的一次性 ReauthTransaction
 * - 二次确认输入邮箱：不匹配不消费 reauth（用户可修正后重试）
 * - 删除是一条 DELETE：所有 tenant-scoped 表对 User 声明 ON DELETE CASCADE，
 *   不靠应用代码逐表清理（漏一张表就是孤儿数据）；certus 账号不受影响
 */
export async function deleteAccount(input: {
  userId: string;
  sessionId: string;
  reauthToken: string | undefined;
  confirmEmail: string;
}): Promise<void> {
  const user = await db.user.findUnique({
    where: { id: input.userId },
    select: { email: true },
  });
  if (!user) throw new DeleteAccountError("user_not_found");

  const expected = (user.email ?? "").trim().toLowerCase();
  if (!expected || input.confirmEmail.trim().toLowerCase() !== expected) {
    throw new DeleteAccountError("email_mismatch");
  }

  if (!input.reauthToken) throw new DeleteAccountError("reauth_required");
  const consumed = await consumeReauthTransaction({
    token: input.reauthToken,
    // 事务绑定真实 Session.id：别的设备完成的 reauth 不能在本会话用（#99）
    sessionId: input.sessionId,
    userId: input.userId,
    action: "delete_account",
  });
  if (!consumed) throw new DeleteAccountError("reauth_invalid");

  await db.user.delete({ where: { id: input.userId } });
}
