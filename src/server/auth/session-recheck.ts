import { db } from "@/server/db";

import { loadAuthConfig } from "./config";
import { certusOIDCProvider, type OIDCProvider } from "./provider";
import {
  decryptSessionTokenCipher,
  encryptSessionTokenCipher,
  toStoredBytes,
} from "./session-db";

/** 活跃会话复核间隔（design §7.1：每 15 分钟至多一次）。 */
export const SESSION_RECHECK_INTERVAL_MS = 15 * 60 * 1000;

export type RecheckOutcome =
  | "fresh" // 距上次复核不足 15 分钟，未动
  | "skipped" // 非 certus 会话或无 refresh token
  | "rotated" // 复核并轮换成功
  | "unreachable" // certus 网络故障：fail-open，会话保留
  | "destroyed"; // 明确 invalid_grant：只销毁该 Session

type LockedSessionRow = {
  id: string;
  authMethod: string;
  authTime: Date;
  lastIdentityCheckedAt: Date | null;
  certusRefreshTokenCipher: Uint8Array | null;
};

/**
 * 会话复核（§7.1 / #112）：活跃 certus 会话距上次复核超 15 分钟时，用加密存储的
 * refresh token 调 certus token 端点轮换。同一 Session 的复核用数据库行锁
 * （SELECT ... FOR UPDATE）串行化，网络调用也在锁内——否则两个并发复核各自拿着
 * 同一份旧 refresh token 去轮换，后到者必然 invalid_grant，会被误判成重放攻击。
 *
 * 失效边界（§6.2/§7.1）：
 * - 明确的 invalid_grant → 只销毁对应 Session（不写 User.suspended，令牌≠停用）
 * - certus 网络故障 → fail-open：会话保留至绝对过期；同时把复核时间拨到
 *   现在，给上游一个 15 分钟的故障窗口而不是每个请求都重试
 */
export async function maybeRecheckSession(
  sessionId: string,
  now: Date = new Date(),
  provider: OIDCProvider = certusOIDCProvider,
): Promise<RecheckOutcome> {
  try {
    return await db.$transaction(
      async (tx) => {
        // 行锁串行化同一 Session 的并发复核
        const rows = await tx.$queryRaw<LockedSessionRow[]>`
          SELECT id, "authMethod", "authTime", "lastIdentityCheckedAt", "certusRefreshTokenCipher"
          FROM "sessions" WHERE id = ${sessionId}::uuid FOR UPDATE`;
        const session = rows[0];
        if (!session) return "destroyed";
        if (session.authMethod !== "certus" || !session.certusRefreshTokenCipher) {
          return "skipped";
        }
        // null = 建会话后还没复核过；登录本身就是一次身份确认，从 authTime 起算
        const baseline = session.lastIdentityCheckedAt ?? session.authTime;
        if (now.getTime() - baseline.getTime() < SESSION_RECHECK_INTERVAL_MS) {
          return "fresh";
        }

        const refreshToken = decryptSessionTokenCipher(session.certusRefreshTokenCipher);
        if (!refreshToken) return "skipped";

        try {
          const tokens = await provider.refreshTokens(loadAuthConfig(), refreshToken);
          await tx.session.update({
            where: { id: sessionId },
            data: {
              lastIdentityCheckedAt: now,
              // refresh token 轮换：端点返回新值才覆盖，否则保留旧密文
              ...(tokens.refreshToken
                ? {
                    certusRefreshTokenCipher: toStoredBytes(
                      encryptSessionTokenCipher(tokens.refreshToken),
                    ),
                  }
                : {}),
              ...(tokens.idToken
                ? {
                    certusIdTokenCipher: toStoredBytes(
                      encryptSessionTokenCipher(tokens.idToken),
                    ),
                  }
                : {}),
            },
          });
          return "rotated";
        } catch (cause) {
          if (isInvalidGrant(cause)) {
            // 明确的拒绝：只销毁该 Session（§6.2 令牌≠停用）
            await tx.session.delete({ where: { id: sessionId } });
            return "destroyed";
          }
          // 网络/上游故障：fail-open，拨复核时间给出 15 分钟故障窗口
          await tx.session.update({
            where: { id: sessionId },
            data: { lastIdentityCheckedAt: now },
          });
          return "unreachable";
        }
      },
      // 锁内有一次上游 HTTP 调用，Prisma 默认 5s 事务超时不够
      { timeout: 20_000 },
    );
  } catch {
    // 复核自身的任何故障（含事务超时）都不得杀死会话：fail-open（§7.1）
    return "unreachable";
  }
}

/** oauth4webapi ResponseBodyError 鸭子类型：token 端点返回的 OAuth error code。 */
function isInvalidGrant(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "error" in cause &&
    (cause as { error?: unknown }).error === "invalid_grant"
  );
}
