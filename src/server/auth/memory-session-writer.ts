import { createAppSession, deleteAppSession, findAppSession, type AppSession } from "./session";
import type { SessionWriter } from "./flow";
import { tokenDigest } from "./opaque-store";

/**
 * In-memory SessionWriter used by unit tests and the M0 PoC path.
 * Does NOT persist across restarts; production uses dbSessionWriter.
 */
export const memorySessionWriter: SessionWriter = {
  async create(input) {
    const { token, session } = createAppSession(
      input.derivedUserId,
      input.now?.getTime(),
    );
    return {
      sessionToken: token,
      userId: input.derivedUserId,
      sessionExpiresAt: session.expiresAt,
    };
  },

  async find(token, now) {
    const session: AppSession | null = findAppSession(token, now?.getTime());
    return session ? { userId: session.userId } : null;
  },

  async delete(token) {
    deleteAppSession(token);
  },
};

export function memorySessionKeysForTests(): string[] {
  return Array.from(
    globalThis.__conspectusSessionRecords?.keys() ?? [],
  ).map((key) => key);
}

export function memorySessionTokenHash(token: string): string {
  return tokenDigest(token);
}
