import { db } from "@/server/db";

import type { SessionWriter } from "./flow";
import { upsertCertusUser } from "./jit-user";
import { AccountSuspendedError } from "./login-policy";
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
    const session = await findPersistentSession(token, now ?? new Date());
    return session ? { userId: session.userId, sessionId: session.id } : null;
  },

  async delete(token) {
    await deletePersistentSession(token);
  },
};
