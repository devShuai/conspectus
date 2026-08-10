import { describe, expect, it } from "vitest";

// 回归 #127：测试必须从 cron 入口加载，而不是直接 import balance-adapters。
// 这样一旦 route 丢掉注册导入，下面的 registry 断言会立即失败。
import "./route";
import { listProviders } from "@/server/usage/sync";

describe("usage-sync provider bootstrap (#127)", () => {
  it("registers every server-side provider from the cron module graph", () => {
    expect(listProviders().map((provider) => provider.id).sort()).toEqual([
      "deepseek",
      "kimi",
      "minimax-coding-plan",
      "xai",
    ]);
  });
});
