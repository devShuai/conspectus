import { HashedTokenStore } from "./opaque-store.js";

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface AppSession {
  userId: string;
  createdAt: number;
  expiresAt: number;
}

declare global {
  var __conspectusSessionRecords: Map<string, AppSession> | undefined;
}

const sessionRecords =
  globalThis.__conspectusSessionRecords ?? new Map<string, AppSession>();
globalThis.__conspectusSessionRecords = sessionRecords;

const sessions = new HashedTokenStore(sessionRecords);

export function createAppSession(userId: string, now = Date.now()): {
  token: string;
  session: AppSession;
} {
  const session: AppSession = {
    userId,
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS,
  };
  return { token: sessions.issue(session, now), session };
}

export function findAppSession(token: string | undefined, now = Date.now()): AppSession | null {
  return sessions.read(token, now);
}

export function deleteAppSession(token: string | undefined): void {
  sessions.delete(token);
}

export function resetAppSessionsForTests(): void {
  sessions.clear();
}

export function appSessionStorageKeysForTests(): string[] {
  return sessions.storageKeysForTests();
}
