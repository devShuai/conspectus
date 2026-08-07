import { beforeEach, describe, expect, it } from "vitest";

import {
  appSessionStorageKeysForTests,
  createAppSession,
  deleteAppSession,
  findAppSession,
  resetAppSessionsForTests,
  SESSION_TTL_MS,
} from "./session";
import { tokenDigest } from "./opaque-store";

describe("application sessions", () => {
  beforeEach(() => resetAppSessionsForTests());

  it("stores only the token hash and resolves to a local userId", () => {
    const now = 1_000;
    const { token, session } = createAppSession("usr_local", now);

    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(appSessionStorageKeysForTests()).toEqual([tokenDigest(token)]);
    expect(appSessionStorageKeysForTests()).not.toContain(token);
    expect(findAppSession(token, now + 1)).toEqual(session);
  });

  it("expires and deletes sessions immediately", () => {
    const now = 2_000;
    const first = createAppSession("usr_first", now);
    expect(findAppSession(first.token, now + SESSION_TTL_MS)).toBeNull();

    const second = createAppSession("usr_second", now);
    deleteAppSession(second.token);
    expect(findAppSession(second.token, now)).toBeNull();
  });
});
