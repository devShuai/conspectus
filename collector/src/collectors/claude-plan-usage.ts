import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

/**
 * Claude 桌面端写的配额历史：`plan-usage-history.json`。
 *
 * ```json
 * {"version":2,"samples":[{"t":1787972231928,"org":"…","u":{"fh":0,"sd":54}}, …]}
 * ```
 *
 * `u.fh` / `u.sd` 是 five_hour / seven_day 的已用百分比。本机实测 2461 个样本、
 * 30 天跨度、中位采样间隔 300 秒 —— 桌面端自己每 5 分钟记一次。
 *
 * 选它而不是 OAuth 端点或 statusLine：不需要凭据（旧实现在 Windows 上因为凭据存在
 * 系统凭据管理器而完全取不到数），也不需要改用户的 statusLine 配置。代价是这是内部
 * 格式（`version: 2` 说明变过），所以下面对形状逐项校验，对不上就返回 null 让调用方
 * 报 unavailable —— 宁可采不到，也不能把猜出来的数字当配额。
 */

export interface PlanUsageSample {
  /** 该样本的采集时刻，不是「现在」—— 桌面端没在跑时读到的是旧值。 */
  capturedAt: Date;
  /** five_hour 已用百分比。 */
  fiveHour: number;
  /** seven_day 已用百分比。 */
  sevenDay: number;
}

const SUPPORTED_VERSION = 2;

export function planUsageHistoryPaths(
  env: Record<string, string | undefined> = process.env,
  platform: string = process.platform,
): string[] {
  const file = "plan-usage-history.json";
  if (platform === "win32") {
    const appData = env.APPDATA ?? resolve(homedir(), "AppData", "Roaming");
    return [resolve(appData, "Claude", file)];
  }
  if (platform === "darwin") {
    return [resolve(homedir(), "Library", "Application Support", "Claude", file)];
  }
  return [resolve(homedir(), ".config", "Claude", file)];
}

/** 取最新样本。形状不符一律返回 null。 */
export function parsePlanUsageHistory(text: string): PlanUsageSample | null {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(body) || body.version !== SUPPORTED_VERSION) return null;
  const samples = body.samples;
  if (!Array.isArray(samples) || samples.length === 0) return null;

  let best: PlanUsageSample | null = null;
  for (const sample of samples) {
    if (!isRecord(sample)) continue;
    const t = Number(sample.t);
    const u = sample.u;
    if (!Number.isFinite(t) || t <= 0 || !isRecord(u)) continue;
    const fiveHour = percent(u.fh);
    const sevenDay = percent(u.sd);
    if (fiveHour === null || sevenDay === null) continue;
    // 样本未必按时间排序，取最大的 t 而不是数组末尾
    if (best === null || t > best.capturedAt.getTime()) {
      best = { capturedAt: new Date(t), fiveHour, sevenDay };
    }
  }
  return best;
}

export function readPlanUsageHistory(
  env: Record<string, string | undefined> = process.env,
  platform: string = process.platform,
): PlanUsageSample | null {
  for (const path of planUsageHistoryPaths(env, platform)) {
    if (!existsSync(path)) continue;
    const parsed = parsePlanUsageHistory(readFileSync(path, "utf8"));
    if (parsed) return parsed;
  }
  return null;
}

function percent(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 100) return null;
  return n;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
