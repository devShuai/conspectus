import { describe, expect, it } from "vitest";

import {
  claudeCredentialUnavailableError,
  extractClaudeAccessToken,
  parseClaudeAuthStatus,
  parseClaudeUsage,
} from "./claude.js";

const BINDINGS = [
  { bindingId: "5h", metric: "claude:five_hour", kind: "quota", unit: "%" },
  { bindingId: "7d", metric: "claude:seven_day", kind: "quota", unit: "%" },
];

describe("Claude Desktop / Code collector", () => {
  it("parses shared five-hour and seven-day utilization", () => {
    expect(
      parseClaudeUsage(
        {
          five_hour: { utilization: 42.5, resets_at: "2026-08-10T15:00:00Z" },
          seven_day: { utilization: 12, resets_at: "2026-08-17T00:00:00Z" },
        },
        BINDINGS,
        "2026-08-10T10:00:00Z",
      ),
    ).toEqual([
      expect.objectContaining({
        bindingId: "5h",
        metric: "claude:five_hour",
        usedValue: "42.5",
        limitValue: "100",
      }),
      expect.objectContaining({
        bindingId: "7d",
        metric: "claude:seven_day",
        usedValue: "12",
        limitValue: "100",
      }),
    ]);
  });

  it("keeps one valid window and rejects out-of-range utilization", () => {
    const readings = parseClaudeUsage(
      {
        five_hour: { utilization: 150 },
        seven_day: { utilization: 5 },
      },
      BINDINGS,
      "2026-08-10T10:00:00Z",
    );
    expect(readings.map((reading) => reading.metric)).toEqual(["claude:seven_day"]);
  });

  it("only emits manifest-authorized bindings", () => {
    const readings = parseClaudeUsage(
      { five_hour: { utilization: 20 }, seven_day: { utilization: 30 } },
      [BINDINGS[0]],
      "2026-08-10T10:00:00Z",
    );
    expect(readings).toHaveLength(1);
    expect(readings[0].bindingId).toBe("5h");
  });

  it("extracts official and compatible OAuth credential shapes", () => {
    const token = "sk-ant-oat01-test-token";
    expect(extractClaudeAccessToken({ claudeAiOauth: { accessToken: token } })).toBe(token);
    expect(extractClaudeAccessToken({ oauth: { access: token } })).toBe(token);
    expect(extractClaudeAccessToken({ accounts: [{ enabled: true, token }] })).toBe(token);
    expect(extractClaudeAccessToken({ accessToken: "sk-ant-api-key" })).toBeNull();
  });

  it("recognizes a signed-in Claude CLI without exposing its secure credential", () => {
    const status = parseClaudeAuthStatus(
      JSON.stringify({ loggedIn: true, authMethod: "oauth_token", apiProvider: "firstParty" }),
    );
    expect(status).toEqual({ loggedIn: true, authMethod: "oauth_token" });
    expect(claudeCredentialUnavailableError(status).message).toContain(
      "unsupported_auth_storage: Claude is signed in",
    );
    expect(claudeCredentialUnavailableError(status).message).not.toContain("auth login");
  });

  it("keeps the login instruction for a signed-out or unreadable CLI status", () => {
    expect(parseClaudeAuthStatus("not-json")).toBeNull();
    expect(claudeCredentialUnavailableError({ loggedIn: false }).message).toContain(
      "auth_required",
    );
  });
});
