import { db } from "@/server/db";

import type { SessionWriter } from "./flow.js";
import { upsertCertusUser } from "./jit-user.js";
import {
  createPersistentSession,
  deletePersistentSession,
  findPersistentSession,
} from "./session-db.js";

/**
 * Production SessionWriter: JIT certus user + persistent DB Session in one
 * transaction. Business code only ever sees session.userId (DB User id).
 */
export const dbSessionWriter: SessionWriter = {
  async create(input) {
    return db.$transaction(async (tx) => {
      const { userId } = await upsertCertusUser(
        {
          sub: input.identity.certusSub,
          sid: input.identity.sid,
          email: input.identity.email,
          emailVerified: input.identity.emailVerified,
          idTokenIat: input.identity.idTokenIat,
          name: input.identity.name,
        },
        input.now ?? new Date(),
        tx,
      );
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
    return session ? { userId: session.userId } : null;
  },

  async delete(token) {
    await deletePersistentSession(token);
  },
};
