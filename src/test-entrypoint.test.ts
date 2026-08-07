import { describe, expect, it } from "vitest";

import config from "../vitest.config";

/**
 * Guard for #69: `collector/` is a separate npm package. While it was only
 * reachable through its own `npm test`, nothing ran it — M4 shipped with zero
 * coverage and the root run still reported a growing green total, so the gap
 * was invisible.
 *
 * Asserting the project list here means dropping a package from the single
 * entry point fails the suite instead of silently shrinking it.
 */
describe("test entry point", () => {
  it("runs every package from one vitest invocation", () => {
    const projects = config.test?.projects ?? [];
    const names = projects.map((p) =>
      typeof p === "string" ? p : (p as { test?: { name?: string } }).test?.name,
    );
    expect(names).toContain("app");
    expect(names).toContain("collector");
  });
});
