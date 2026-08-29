import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const appData = resolve(homedir(), "AppData", "Roaming");

import { parsePlanUsageHistory, planUsageHistoryPaths } from "./claude-plan-usage.js";
import { parseCodeburnExport, SUPPORTED_SCHEMA } from "./codeburn-export.js";

describe("parsePlanUsageHistory", () => {
  const sample = (t: number, fh: number, sd: number) => ({ t, org: "o", u: { fh, sd } });

  it("reads the five-hour and seven-day percentages", () => {
    const parsed = parsePlanUsageHistory(
      JSON.stringify({ version: 2, samples: [sample(1_787_972_231_928, 12, 54)] }),
    );
    expect(parsed).toEqual({
      capturedAt: new Date(1_787_972_231_928),
      fiveHour: 12,
      sevenDay: 54,
    });
  });

  // 样本未必按时间排序，取数组末尾会拿到旧值
  it("takes the newest sample rather than the last element", () => {
    const parsed = parsePlanUsageHistory(
      JSON.stringify({
        version: 2,
        samples: [sample(3_000, 9, 9), sample(1_000, 1, 1)],
      }),
    );
    expect(parsed?.capturedAt).toEqual(new Date(3_000));
    expect(parsed?.fiveHour).toBe(9);
  });

  /*
   * 这是个内部格式（version 已经从 1 变到 2 过）。格式漂移时必须变成「采不到」，
   * 而不是把猜出来的数字当配额往上报。
   */
  it("refuses an unknown version", () => {
    expect(
      parsePlanUsageHistory(JSON.stringify({ version: 3, samples: [sample(1, 1, 1)] })),
    ).toBeNull();
  });

  it("skips samples whose percentages are out of range", () => {
    expect(
      parsePlanUsageHistory(JSON.stringify({ version: 2, samples: [sample(1, 101, 5)] })),
    ).toBeNull();
  });

  it("survives malformed json and empty sample sets", () => {
    expect(parsePlanUsageHistory("{oops")).toBeNull();
    expect(parsePlanUsageHistory(JSON.stringify({ version: 2, samples: [] }))).toBeNull();
  });

  it("points at the platform's Claude desktop directory", () => {
    // 用 join 拼期望值，避免在断言里写平台相关的分隔符
    const tail = (...parts: string[]) => join(...parts);
    expect(planUsageHistoryPaths({ APPDATA: appData }, "win32")[0]).toBe(
      tail(appData, "Claude", "plan-usage-history.json"),
    );
    expect(planUsageHistoryPaths({}, "darwin")[0]).toBe(
      tail(homedir(), "Library", "Application Support", "Claude", "plan-usage-history.json"),
    );
    expect(planUsageHistoryPaths({}, "linux")[0]).toBe(
      tail(homedir(), ".config", "Claude", "plan-usage-history.json"),
    );
  });
});

describe("parseCodeburnExport", () => {
  const exportBody = (schema: string) =>
    JSON.stringify({
      schema,
      generated: "2026-08-29T03:12:50.737Z",
      periods: [
        { label: "Today", models: [] },
        {
          label: "30 Days",
          models: [
            {
              Model: "Opus 5",
              "Input Tokens": 100,
              "Output Tokens": 200,
              "Cache Read Tokens": 300,
              "Cache Write Tokens": 400,
              "Cost (USD)": 12.5,
              "API Calls": 7,
            },
          ],
        },
      ],
    });

  it("sums the newest period across models", () => {
    const totals = parseCodeburnExport(exportBody(SUPPORTED_SCHEMA));
    expect(totals?.totalTokens).toBe(1000);
    expect(totals?.costUSD).toBe(12.5);
    expect(totals?.apiCalls).toBe(7);
    expect(totals?.generatedAt).toEqual(new Date("2026-08-29T03:12:50.737Z"));
    expect(totals?.models[0]?.model).toBe("Opus 5");
  });

  // 依赖的是导出契约而非内部实现，schema 变了就停手
  it("refuses an unexpected schema", () => {
    expect(parseCodeburnExport(exportBody("codeburn.export.v3"))).toBeNull();
  });

  it("returns null when there is nothing to report", () => {
    expect(parseCodeburnExport("not json")).toBeNull();
    expect(
      parseCodeburnExport(JSON.stringify({ schema: SUPPORTED_SCHEMA, periods: [] })),
    ).toBeNull();
  });
});
