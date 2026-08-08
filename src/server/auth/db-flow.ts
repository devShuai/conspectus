import { db } from "@/server/db";

import type { SessionWriter } from "./flow";
import { upsertCertusUser } from "./jit-user";
import { AccountSuspendedError } from "./login-policy";
import { maybeRecheckSession } from "./session-recheck";
import {
  createPersistentSession,
  deletePersistentSession,
  findPersistentSession,
} from "./session-db";

/**
 * Production SessionWriter: JIT certus user + persistent DB Session in one
 * transaction. Business code only ever sees session.userId (DB User id).
 */
export const dbSessionWriter: SessionWriter = {
  async create(input) {
    return db.$transaction(async (tx) => {
      const { userId, user } = await upsertCertusUser(
        {
          sub: input.identity.certusSub,
          legacySub: input.identity.legacySub,
          sid: input.identity.sid,
          email: input.identity.email,
          emailVerified: input.identity.emailVerified,
          idTokenIat: input.identity.idTokenIat,
          name: input.identity.name,
        },
        input.now ?? new Date(),
        tx,
      );
      if (user.status === "suspended") {
        throw new AccountSuspendedError();
      }
      const created = await createPersistentSession(
        {
          userId,
          authMethod: "certus",
          certusSid: input.identity.sid,
          refreshToken: input.refreshToken,
          idToken: input.idToken,
          now: input.now,
        },
        { client: tx },
      );
      return {
        sessionToken: created.token,
        userId: created.userId,
        sessionExpiresAt: created.expiresAt.getTime(),
      };
    });
  },

  async find(token, now) {
    const at = now ?? new Date();
    const session = await findPersistentSession(token, at);
    if (!session) return null;
    // §7.1 会话复核：超过 15 分钟用 refresh token 轮换；
    // 复核发现 invalid_grant 时会话已被销毁，不得再放行
    const recheck = await maybeRecheckSession(session.id, at);
    if (recheck === "destroyed") return null;
    return { userId: session.userId, sessionId: session.id };
  },

  async delete(token) {
    await deletePersistentSession(token);
  },
};
