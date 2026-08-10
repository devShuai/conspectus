import { describe, expect, it } from "vitest";

import { listBalanceAdapters, parseMiniMaxCodingPlan } from "./balance-adapters";
import type { SyncContext } from "../sync";

const MINIMAX_CONTEXT: SyncContext = {
  userId: "user-1",
  connectionId: "connection-1",
  allowedBindings: [
    { bindingId: "binding-5h", metric: "minimax:5h", kind: "quota", unit: "req" },
    { bindingId: "binding-weekly", metric: "minimax:weekly", kind: "quota", unit: "req" },
  ],
};

describe("balance adapters", () => {
  it("registers balance providers and the server-side MiniMax Coding Plan provider", () => {
    const adapters = listBalanceAdapters();
    expect(adapters.map((a) => a.id).sort()).toEqual([
      "deepseek",
      "kimi",
      "minimax-coding-plan",
      "xai",
    ]);
  });

  it("parses MiniMax 5h and weekly remaining counts into independent used quotas", () => {
    const readings = parseMiniMaxCodingPlan(
      {
        base_resp: { status_code: 0, status_msg: "success" },
        model_remains: [
          {
            model_name: "MiniMax-M*",
            start_time: 1_774_587_600_000,
            end_time: 1_774_605_600_000,
            current_interval_total_count: "1500",
            current_interval_usage_count: 1200,
            current_weekly_total_count: 15000,
            current_weekly_usage_count: "9000",
            weekly_start_time: 1_774_224_000_000,
            weekly_end_time: 1_774_828_800_000,
          },
        ],
      },
      MINIMAX_CONTEXT,
      "2026-03-27T10:00:00.000Z",
    );
    expect(readings).toEqual([
      expect.objectContaining({
        bindingId: "binding-5h",
        metric: "minimax:5h",
        usedValue: "300",
        limitValue: "1500",
        periodEnd: "2026-03-27T10:00:00.000Z",
      }),
      expect.objectContaining({
        bindingId: "binding-weekly",
        metric: "minimax:weekly",
        usedValue: "6000",
        limitValue: "15000",
        periodEnd: "2026-03-30T00:00:00.000Z",
      }),
    ]);
  });

  it("keeps a usable MiniMax window when the other window is absent", () => {
    const readings = parseMiniMaxCodingPlan(
      {
        base_resp: { status_code: "0" },
        model_remains: [
          { current_interval_total_count: 100, current_interval_usage_count: 25 },
        ],
      },
      MINIMAX_CONTEXT,
      "2026-03-27T10:00:00.000Z",
    );
    expect(readings).toHaveLength(1);
    expect(readings[0]).toMatchObject({ metric: "minimax:5h", usedValue: "75" });
  });

  it("rejects upstream status failures and rows without usable quota", () => {
    expect(() =>
      parseMiniMaxCodingPlan({ base_resp: { status_code: 1004 } }, MINIMAX_CONTEXT, "now"),
    ).toThrow("unexpected MiniMax status");
    expect(() =>
      parseMiniMaxCodingPlan(
        { base_resp: { status_code: 0 }, model_remains: [{}] },
        MINIMAX_CONTEXT,
        "now",
      ),
    ).toThrow("missing MiniMax quota data");
    expect(() => parseMiniMaxCodingPlan(null, MINIMAX_CONTEXT, "now")).toThrow(
      "unexpected MiniMax schema",
    );
    expect(() =>
      parseMiniMaxCodingPlan(
        { base_resp: { status_code: 0 }, model_remains: { not: "an array" } },
        MINIMAX_CONTEXT,
        "now",
      ),
    ).toThrow("missing MiniMax quota data");
  });
});
