import { describe, expect, it } from "vitest";

import { resolveDatabaseUrl } from "./db";

describe("resolveDatabaseUrl (#64)", () => {
  const prod = { DATABASE_URL: "postgres://prod/db" };

  it("honors TEST_DATABASE_URL in the test environment", () => {
    expect(
      resolveDatabaseUrl({
        ...prod,
        NODE_ENV: "test",
        TEST_DATABASE_URL: "postgres://test/db",
      }),
    ).toBe("postgres://test/db");
    expect(
      resolveDatabaseUrl({
        NODE_ENV: "test",
        TEST_DATABASE_URL: "postgres://test/db",
      }),
    ).toBe("postgres://test/db");
  });

  it("falls back to DATABASE_URL in the test environment when TEST_DATABASE_URL is unset", () => {
    expect(resolveDatabaseUrl({ ...prod, NODE_ENV: "test" })).toBe(
      "postgres://prod/db",
    );
    expect(resolveDatabaseUrl({ ...prod, VITEST: "true" })).toBe(
      "postgres://prod/db",
    );
  });

  it("ignores TEST_DATABASE_URL outside the test environment", () => {
    expect(
      resolveDatabaseUrl({
        ...prod,
        NODE_ENV: "development",
        TEST_DATABASE_URL: "postgres://test/db",
      }),
    ).toBe("postgres://prod/db");
  });

  it("refuses production when TEST_DATABASE_URL is present", () => {
    expect(() =>
      resolveDatabaseUrl({
        ...prod,
        NODE_ENV: "production",
        TEST_DATABASE_URL: "postgres://test/db",
      }),
    ).toThrow(/TEST_DATABASE_URL/);
  });

  it("uses DATABASE_URL in production when TEST_DATABASE_URL is absent", () => {
    expect(resolveDatabaseUrl({ ...prod, NODE_ENV: "production" })).toBe(
      "postgres://prod/db",
    );
  });

  it("does not fail the production build phase (build serves no traffic)", () => {
    expect(
      resolveDatabaseUrl({
        ...prod,
        NODE_ENV: "production",
        NEXT_PHASE: "phase-production-build",
        TEST_DATABASE_URL: "postgres://test/db",
      }),
    ).toBe("postgres://prod/db");
  });

  it("requires a database url", () => {
    expect(() => resolveDatabaseUrl({ NODE_ENV: "production" })).toThrow(
      /DATABASE_URL/,
    );
  });
});
