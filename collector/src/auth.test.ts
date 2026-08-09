import { describe, expect, it } from "vitest";

import { SCOPES } from "./auth.js";

describe("device login scopes", () => {
  it("requests exactly the design §7.4 scope set (openid profile usage:write)", () => {
    expect(SCOPES.split(" ").sort()).toEqual(["openid", "profile", "usage:write"]);
  });
});
