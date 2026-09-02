import { describe, expect, it } from "vitest";

import { renderShow, summarizeLedger, type ShowModel } from "./show.js";

const PIPED = { isTTY: false, columns: 100 };
const NO_ENV: Record<string, string | undefined> = {};

function model(overrides: Partial<ShowModel> = {}): ShowModel {
  return {
    generatedAt: new Date("2026-09-01T12:00:00Z"),
    agentVersion: "0.5.0",
    server: { url: "https://c.example.test", issuer: "https://auth.example.test", reachable: true, status: 401 },
    auth: { loggedIn: true, expiresAt: "2026-09-01T13:00:00.000Z", expired: false },
    device: { registered: true, deviceId: "dev-1" },
    bindings: [],
    collectorErrors: [],
    warnings: [],
    spend: null,
    buffer: { batches: 0, readings: 0, oldestEnqueuedAt: null, lastError: null },
    ...overrides,
  };
}

function render(overrides: Partial<ShowModel> = {}): string {
  return renderShow(model(overrides), PIPED, NO_ENV);
}

describe("renderShow", () => {
  it("emits no ANSI escapes when piped", () => {
    expect(render()).not.toContain("[");
  });

  it("keeps every line within the terminal width", () => {
    const out = render({
      bindings: [
        {
          collectorId: "claude-code",
          metric: "claude:five_hour",
          kind: "quota",
          unit: "percent",
          used: "42",
          limit: "100",
          capturedAt: "2026-09-01T11:00:00.000Z",
        },
      ],
      spend: summarizeLedger(ledger()),
    });
    for (const line of out.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(120);
    }
  });

  it("distinguishes a failed manifest fetch from an empty manifest", () => {
    // 两种状态都会让绑定表为空，但原因完全不同 —— 混为一谈就是 #128 那个坑
    expect(render({ bindings: null, manifestError: "未登录" })).toContain("无法获取 manifest");
    const empty = render({ bindings: [] });
    expect(empty).not.toContain("无法获取 manifest");
    expect(empty).toContain("没有本地采集绑定");
  });

  it("marks a binding that produced no reading", () => {
    const out = render({
      bindings: [
        { collectorId: "kimi-code", metric: "kimi:5h", kind: "quota", unit: "percent" },
      ],
    });
    expect(out).toContain("未采到");
  });

  it("says so when not logged in instead of showing a bare cross", () => {
    const out = render({ auth: { loggedIn: false }, device: { registered: false } });
    expect(out).toContain("未登录");
    expect(out).toContain("conspectus-collect login");
  });

  it("reports buffered readings and stays quiet when the buffer is empty", () => {
    expect(render()).toContain("缓冲区为空");
    const out = render({
      buffer: { batches: 2, readings: 7, oldestEnqueuedAt: "2026-08-31T00:00:00Z", lastError: "boom" },
    });
    expect(out).toContain("7 条读数积压");
    expect(out).toContain("最旧一批");
  });

  it("explains a skipped or failed spend section rather than showing zeros", () => {
    // 显示 $0.00 会被读成「这个月没花钱」，与「没采到」是两回事
    const out = render({ spend: null, spendError: "已用 --no-spend 跳过" });
    expect(out).toContain("已用 --no-spend 跳过");
    expect(out).not.toContain("$0.00");
  });

  it("points at a command that actually exists on PATH", () => {
    // codeburn 是本包依赖，bin 垫片不在 PATH 上；提示里写裸 `codeburn today`
    // 对没另行全局安装的人是句跑不通的建议（0.6.0 就是这么发出去的）
    const out = render({ spend: summarizeLedger(ledger()) });
    expect(out).toContain("conspectus-collect codeburn");
    expect(out).not.toMatch(/(?<!conspectus-collect )codeburn today/);
  });

  it("flags a non-USD codeburn display currency", () => {
    const out = render({
      spend: summarizeLedger({ ...ledger(), sourceCurrency: "GBP" }),
    });
    expect(out).toContain("GBP");
    expect(out).toContain("折算回 USD");
  });
});

function day(overrides: Record<string, unknown> = {}) {
  return {
    provider: "claude",
    category: "coding",
    inputTokens: 10,
    outputTokens: 20,
    reasoningTokens: 5,
    cacheReadTokens: 30,
    cacheWriteTokens: 40,
    apiCalls: 3,
    costUsd: 1.5,
    savedUsd: 0,
    ...overrides,
  };
}

function ledger() {
  return {
    sourceCurrency: "USD",
    days: [day(), day({ provider: "codex", category: "debugging", costUsd: 2.5, apiCalls: 4 })],
    sessions: [{}, {}, {}],
  };
}

describe("summarizeLedger", () => {
  it("keeps reasoning tokens out of the token total", () => {
    // codex/opencode 的 reasoning 是 output 的子集，grok 的是独立计量；
    // 合并会把占多数的前者算重
    const spend = summarizeLedger(ledger());
    expect(spend.tokens).toBe(200);
    expect(spend.reasoningTokens).toBe(10);
  });

  it("counts sessions from the session snapshot, not the daily rows", () => {
    expect(summarizeLedger(ledger()).sessions).toBe(3);
  });

  it("ranks providers and categories by cost", () => {
    const spend = summarizeLedger(ledger());
    expect(spend.byProvider.map((r) => r.key)).toEqual(["codex", "claude"]);
    expect(spend.byCategory.map((r) => r.key)).toEqual(["debugging", "coding"]);
    expect(spend.costUsd).toBe(4);
  });

  it("labels rows with no category rather than dropping them", () => {
    const spend = summarizeLedger({ ...ledger(), days: [day({ category: "" })] });
    expect(spend.byCategory[0].key).toBe("未分类");
  });
});
