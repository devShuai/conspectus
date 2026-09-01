import { describe, expect, it } from "vitest";

import {
  aggregateCodeburnExport,
  SUPPORTED_SCHEMA,
} from "./codeburn-export.js";

function record(overrides: Record<string, unknown> = {}) {
  return {
    project: "C:\\Users\\someone\\dev\\secret-client\\api",
    sessionId: "s-1",
    timestamp: "2026-08-18T10:00:00.000Z",
    category: "coding",
    provider: "claude",
    model: "claude-opus-5",
    inputTokens: 10,
    outputTokens: 20,
    reasoningTokens: 5,
    cacheWriteTokens: 3,
    cacheReadTokens: 7,
    cost: 1,
    savings: 0,
    ...overrides,
  };
}

function body(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    schema: SUPPORTED_SCHEMA,
    generated: "2026-08-18T12:00:00.000Z",
    currency: { code: "USD", rate: 1, symbol: "$" },
    records: [record()],
    sessions: [
      {
        Project: "/home/someone/dev/secret-client/api",
        "Session ID": "s-1",
        "Started At": "2026-08-18T09:00:00.000Z",
        "Cost (USD)": 12.5,
        "Saved (USD)": 0,
        "API Calls": 40,
        Turns: 9,
      },
    ],
    tools: [{ Tool: "Bash", Calls: 100, "Share (%)": 60 }],
    mcp: [{ Server: "node_repl", Calls: 20, "Share (%)": 100 }],
    periods: [
      { label: "Today", models: [] },
      {
        label: "30 Days",
        models: [
          {
            Model: "Opus 5",
            "Cost (USD)": 30,
            "Saved (USD)": 0,
            "Share (%)": 75,
            "API Calls": 12,
            "Edit Turns": 4,
            "One-shot Rate (%)": 84.6,
            "Retries/Edit": 0.3,
            "Cost/Edit (USD)": 7.5,
          },
        ],
      },
    ],
    ...overrides,
  });
}

describe("aggregateCodeburnExport", () => {
  it("rejects an unknown schema instead of guessing field names", () => {
    expect(aggregateCodeburnExport(body({ schema: "codeburn.export.v3" }))).toBeNull();
    expect(aggregateCodeburnExport("not json")).toBeNull();
  });

  it("keeps every dimension codeburn exposes", () => {
    const ledger = aggregateCodeburnExport(body());
    expect(ledger).not.toBeNull();
    const day = ledger!.days[0];
    expect(day.category).toBe("coding");
    expect(day.reasoningTokens).toBe(5);
    expect(day.provider).toBe("claude");
    expect(ledger!.tools).toEqual([
      { kind: "tool", name: "Bash", calls: 100, sharePct: 60 },
      { kind: "mcp", name: "node_repl", calls: 20, sharePct: 100 },
    ]);
    expect(ledger!.models[0]).toMatchObject({
      model: "Opus 5",
      oneShotRatePct: 84.6,
      retriesPerEdit: 0.3,
      costPerEditUsd: 7.5,
    });
  });

  it("splits one day into separate rows per task category", () => {
    const ledger = aggregateCodeburnExport(
      body({
        records: [
          record({ category: "coding", cost: 1 }),
          record({ category: "debugging", cost: 2 }),
        ],
      }),
    );
    expect(ledger!.days).toHaveLength(2);
    expect(ledger!.days.map((d) => d.category).sort()).toEqual(["coding", "debugging"]);
  });

  it("reduces project paths to the last segment on both path separators", () => {
    const ledger = aggregateCodeburnExport(body());
    // 绝对路径里含用户名与客户名，只有最后一段该出机器
    expect(ledger!.days[0].projectKey).toBe("api");
    expect(ledger!.sessions[0].projectKey).toBe("api");
  });

  it("never emits the shell command list", () => {
    const ledger = aggregateCodeburnExport(
      body({ shellCommands: [{ Command: "psql postgres://u:pw@host/db", Calls: 3 }] }),
    );
    expect(JSON.stringify(ledger)).not.toContain("psql");
  });

  it("normalises money back to USD when codeburn displays another currency", () => {
    // codeburn 导出时做的是 displayed = usd * rate，照抄会把英镑写进 costUsd
    const ledger = aggregateCodeburnExport(
      body({
        currency: { code: "GBP", rate: 0.5, symbol: "£" },
        records: [record({ cost: 1, savings: 0.5 })],
      }),
    );
    expect(ledger!.sourceCurrency).toBe("GBP");
    expect(ledger!.days[0].costUsd).toBe(2);
    expect(ledger!.days[0].savedUsd).toBe(1);
  });

  it("skips supplementary accounting rows when counting API calls", () => {
    // codeburn 的 records 是原始账本，补充记账行不是一次真实调用
    const ledger = aggregateCodeburnExport(
      body({ records: [record(), record({ supplementary: true, cost: 99 })] }),
    );
    expect(ledger!.days).toHaveLength(1);
    expect(ledger!.days[0].apiCalls).toBe(1);
    expect(ledger!.days[0].costUsd).toBe(1);
  });

  it("backfills session provider from the records table", () => {
    // sessions 表本身不带 provider
    const ledger = aggregateCodeburnExport(body());
    expect(ledger!.sessions[0].provider).toBe("claude");
  });

  it("counts distinct sessions rather than records", () => {
    const ledger = aggregateCodeburnExport(
      body({ records: [record({ sessionId: "a" }), record({ sessionId: "a" })] }),
    );
    expect(ledger!.days[0].apiCalls).toBe(2);
    expect(ledger!.days[0].sessions).toBe(1);
  });
});
