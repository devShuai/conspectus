import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

import type { LocalCollector, UsageReading } from "../types.js";
import { readPlanUsageHistory, type PlanUsageSample } from "./claude-plan-usage.js";
import {
  resolveCodeburnEntry,
  runCodeburnExport,
  type CodeburnTotals,
} from "./codeburn-export.js";
import { registerCollector } from "./registry.js";

/**
 * Claude 采集器（#136 重做）。两个来源彼此独立，都不需要凭据：
 *
 * - **配额百分比** ← 桌面端的 `plan-usage-history.json`（见 claude-plan-usage.ts）
 * - **token 消耗** ← `codeburn export --format json`（见 codeburn-export.ts）
 *
 * 旧实现读本地 OAuth 凭据打未公开的 usage 端点，在 Windows 上完全走不通 —— 凭据存在
 * 系统凭据管理器里，四个候选文件路径一个都不存在，只能报 unsupported_auth_storage
 * 并要求用户额外跑 `claude setup-token`。整条路径已删除。
 *
 * 两个来源分别取数、互不牵连：一个失败不影响另一个产出读数，两个都没有才报
 * unavailable。（单条 binding 采不到目前仍是静默的，见 #134。）
 */
export const claudeCollector: LocalCollector = {
  id: "claude-code",
  displayName: "Claude Desktop / Claude Code",

  async detect(): Promise<boolean> {
    if (readPlanUsageHistory() !== null) return true;
    if (existsSync(resolve(homedir(), ".claude", "projects"))) return true;
    return resolveCodeburnEntry() !== null;
  },

  async collect(ctx): Promise<UsageReading[]> {
    const readings: UsageReading[] = [];
    const failures: string[] = [];

    let plan: PlanUsageSample | null = null;
    try {
      plan = readPlanUsageHistory();
      if (plan === null) failures.push("plan-usage-history 不存在或格式不符");
    } catch (error) {
      failures.push(`plan-usage-history 读取失败: ${message(error)}`);
    }
    if (plan) appendPlanUsage(readings, ctx.bindings, plan);

    let totals: CodeburnTotals | null = null;
    try {
      totals = await runCodeburnExport("claude");
      if (totals === null) failures.push("codeburn 导出为空或 schema 不符");
    } catch (error) {
      failures.push(`codeburn 导出失败: ${message(error)}`);
    }
    if (totals) appendTokenCounter(readings, ctx.bindings, totals);

    if (readings.length === 0) {
      throw new Error(`unavailable: ${failures.join("；") || "没有匹配的 binding"}`);
    }
    return readings;
  },
};

function appendPlanUsage(
  output: UsageReading[],
  bindings: Array<{ bindingId: string; metric: string; kind: string; unit: string }>,
  sample: PlanUsageSample,
): void {
  // capturedAt 用样本自身的时刻而非「现在」：桌面端没在跑时读到的是旧值，
  // 谎报成刚采到的会让 ingest 的 CAS 用陈旧数字盖掉新的（§7.4 不得用旧数字冒充新数据）
  const capturedAt = sample.capturedAt.toISOString();
  for (const [metric, value] of [
    ["claude:five_hour", sample.fiveHour],
    ["claude:seven_day", sample.sevenDay],
  ] as const) {
    const binding = bindings.find((b) => b.metric === metric && b.kind === "quota");
    if (!binding) continue;
    output.push({
      bindingId: binding.bindingId,
      kind: "quota",
      metric,
      unit: binding.unit,
      usedValue: String(value),
      limitValue: "100",
      capturedAt,
    });
  }
}

function appendTokenCounter(
  output: UsageReading[],
  bindings: Array<{ bindingId: string; metric: string; kind: string; unit: string }>,
  totals: CodeburnTotals,
): void {
  const binding = bindings.find((b) => b.metric === "claude:tokens" && b.kind === "counter");
  if (!binding) return;
  output.push({
    bindingId: binding.bindingId,
    kind: "counter",
    metric: "claude:tokens",
    unit: binding.unit,
    usedValue: String(totals.totalTokens),
    capturedAt: totals.generatedAt.toISOString(),
  });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

registerCollector(claudeCollector);
