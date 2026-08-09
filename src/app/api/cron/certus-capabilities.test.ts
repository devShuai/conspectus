import { describe, expect, it, vi } from "vitest";

/**
 * certus-capabilities 每日复核的结构化日志落点（#121-9，§5.4）：结果以
 * JSON 行写 stdout/stderr，指标与运维面板从这些字段提取；失败只告警。
 */

const fetchClientCapabilities = vi.hoisted(() => vi.fn());
vi.mock("@/server/auth/certus-client-api", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/auth/certus-client-api")>();
  return { ...original, fetchClientCapabilities };
});

const { GET } = await import("./certus-capabilities/route");

function authedRequest() {
  return new Request("http://localhost/api/cron/certus-capabilities", {
    headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
  });
}

const goodEvidence = {
  httpStatus: 200,
  schemaVersion: 1,
  features: ["client_user_status", "email_verified"],
  introspectionSources: ["conspectus-cli"],
  configRevision: "rev-test-1",
  hasClientUserStatus: true,
  hasEmailVerifiedFeature: true,
  hasCrossClientIntrospection: true,
  includesCliSource: true,
  cacheControl: "no-store",
};

describe("certus-capabilities structured logging", () => {
  it("logs a JSON metric line on success", async () => {
    fetchClientCapabilities.mockResolvedValue(goodEvidence);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const response = await GET(authedRequest());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");

    const line = log.mock.calls
      .map((call) => String(call[0]))
      .find((entry) => entry.includes("certus_capabilities_check"));
    expect(line).toBeDefined();
    const record = JSON.parse(line!);
    expect(record).toMatchObject({
      event: "certus_capabilities_check",
      ok: true,
      httpStatus: 200,
      configRevision: "rev-test-1",
      features: ["client_user_status", "email_verified"],
      introspectionSources: ["conspectus-cli"],
      failedChecks: [],
    });
  });

  it("alerts with a JSON error line on upstream failure and stays 200", async () => {
    fetchClientCapabilities.mockRejectedValue(new Error("connect ECONNREFUSED"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await GET(authedRequest());
    // 失败只告警，不拉红高频探针（§5.4）
    expect(response.status).toBe(200);

    const line = error.mock.calls
      .map((call) => String(call[0]))
      .find((entry) => entry.includes("certus_capabilities_check"));
    expect(line).toBeDefined();
    const record = JSON.parse(line!);
    expect(record).toMatchObject({
      event: "certus_capabilities_check",
      ok: false,
      error: "Error",
    });
  });
});
