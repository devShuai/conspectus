import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

import { runCli } from "../exec.js";

/**
 * 通过 codeburn 的导出命令取 token 消耗（#136）。
 *
 * 为什么依赖它而不是自己解析 `~/.claude/projects`：
 *
 * - **去重**。本机实测 14 个文件共 9856 条带 usage 的行，唯一 `message.id` 只有
 *   5334 —— 会话 resume / fork 会把同一条 assistant 消息写进多个文件，不去重会虚高
 *   85%。codeburn 以 `message.id` 为去重键，这一层自己实现极易做错。
 * - **多根发现**。除用户级 `~/.claude/projects`，桌面端的 local agent mode 会话另存
 *   在 `%APPDATA%/Claude/local-agent-mode-sessions/<app>/<workspace>/local_<id>/.claude/projects/`，
 *   只扫前者会静默少计。
 * - 附带按模型拆分与成本口径，本项目原本没有。
 *
 * 依赖的是它的**导出契约**而非内部模块：codeburn 的 package.json 没有 `exports`、
 * 没有 `types`，deep-import `dist/parser.js` 等于拿实现当契约。而 `export --format
 * json` 是面向程序消费设计的（其源码注释：「always get parseable output, never
 * prose」），产物带 `schema` 版本号。
 */

/** 只认这个 schema；对不上宁可报 unavailable，也不猜字段。 */
export const SUPPORTED_SCHEMA = "codeburn.export.v2";

export interface CodeburnModelTotals {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUSD: number;
  apiCalls: number;
}

export interface CodeburnTotals {
  /** 导出生成时刻。 */
  generatedAt: Date;
  /** 30 天窗口的合计 token（四类相加）。 */
  totalTokens: number;
  costUSD: number;
  apiCalls: number;
  models: CodeburnModelTotals[];
}

/**
 * 解析 `codeburn export --format json` 的产物，取 30 天周期。
 *
 * 周期标签由 codeburn 决定（Today / 7 Days / 30 Days）；取最后一个而不是按标签字符串
 * 匹配，免得它改文案就崩。
 */
export function parseCodeburnExport(text: string): CodeburnTotals | null {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(body) || body.schema !== SUPPORTED_SCHEMA) return null;

  const periods = body.periods;
  if (!Array.isArray(periods) || periods.length === 0) return null;
  const period = periods[periods.length - 1];
  if (!isRecord(period) || !Array.isArray(period.models)) return null;

  const models: CodeburnModelTotals[] = [];
  for (const row of period.models) {
    if (!isRecord(row)) continue;
    const model = typeof row.Model === "string" ? row.Model : null;
    if (!model) continue;
    models.push({
      model,
      inputTokens: count(row["Input Tokens"]),
      outputTokens: count(row["Output Tokens"]),
      cacheReadTokens: count(row["Cache Read Tokens"]),
      cacheWriteTokens: count(row["Cache Write Tokens"]),
      costUSD: count(row["Cost (USD)"]),
      apiCalls: count(row["API Calls"]),
    });
  }
  if (models.length === 0) return null;

  const generated = typeof body.generated === "string" ? Date.parse(body.generated) : Number.NaN;
  return {
    generatedAt: Number.isNaN(generated) ? new Date() : new Date(generated),
    totalTokens: models.reduce(
      (sum, m) => sum + m.inputTokens + m.outputTokens + m.cacheReadTokens + m.cacheWriteTokens,
      0,
    ),
    costUSD: models.reduce((sum, m) => sum + m.costUSD, 0),
    apiCalls: models.reduce((sum, m) => sum + m.apiCalls, 0),
    models,
  };
}

/**
 * 定位 codeburn 的入口。
 *
 * 它是本包的依赖，二进制装在 `node_modules/.bin` 下而**不在 PATH 上** —— 全局安装后
 * 直接 `runCli("codeburn", …)` 会 ENOENT。所以从依赖解析出 `dist/cli.js`，再用当前
 * node 跑它：既绕开 PATH，也绕开 Windows 上 npm 垫片必须走 shell 的那套麻烦
 * （绝对路径的 .exe 不经 shell，见 exec.ts 的 usesShell）。
 */
export function resolveCodeburnEntry(): string | null {
  try {
    const require = createRequire(import.meta.url);
    const manifest = require.resolve("codeburn/package.json");
    return resolve(dirname(manifest), "dist", "cli.js");
  } catch {
    return null;
  }
}

/**
 * 跑一次导出并读回结果。写到临时目录再读 —— codeburn 只支持输出到文件，不支持
 * stdout；临时文件用完即删，不在用户目录留痕。
 */
async function exportRaw(
  provider: string,
  options: { entry?: string; timeoutMs?: number },
): Promise<string> {
  const entry = options.entry ?? resolveCodeburnEntry();
  if (!entry) throw new Error("codeburn 依赖未安装");
  const dir = mkdtempSync(resolve(tmpdir(), "conspectus-codeburn-"));
  const output = resolve(dir, "export.json");
  try {
    await runCli(
      process.execPath,
      [entry, "export", "--format", "json", "--provider", provider, "--output", output],
      options.timeoutMs ?? 300_000,
    );
    return readFileSync(output, "utf8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * 跑一次导出取合计。写到临时目录再读 —— codeburn 只支持输出到文件，不支持 stdout；
 * 临时文件用完即删，不在用户目录留痕。
 */
export async function runCodeburnExport(
  provider: string,
  options: { entry?: string; timeoutMs?: number } = {},
): Promise<CodeburnTotals | null> {
  return parseCodeburnExport(await exportRaw(provider, options));
}

/** 同一次导出的按日聚合，供流水账上报（#143）。 */
export async function runCodeburnLedger(
  provider: string,
  options: { entry?: string; timeoutMs?: number } = {},
): Promise<LedgerDayRow[] | null> {
  return aggregateCodeburnRecords(await exportRaw(provider, options));
}

function count(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 上报给服务端的按日聚合行（与服务端 LedgerDaySchema 对齐）。 */
export interface LedgerDayRow {
  day: string;
  provider: string;
  projectKey: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  apiCalls: number;
  sessions: number;
  costUsd: number;
}

/**
 * 把 codeburn 的逐条记录聚合成「日 × provider × 项目 × 模型」。
 *
 * 服务端只存聚合：本机单用户仅 claude 30 天就有 3502 条明细，聚合后是数十行；明细
 * 留在本机由 codeburn 保管。会话数按去重的 sessionId 计，不是记录数。
 */
export function aggregateCodeburnRecords(text: string): LedgerDayRow[] | null {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(body) || body.schema !== SUPPORTED_SCHEMA) return null;
  const records = body.records;
  if (!Array.isArray(records)) return null;

  const buckets = new Map<string, LedgerDayRow & { sessionIds: Set<string> }>();
  for (const raw of records) {
    if (!isRecord(raw)) continue;
    const timestamp = typeof raw.timestamp === "string" ? Date.parse(raw.timestamp) : Number.NaN;
    const provider = typeof raw.provider === "string" ? raw.provider : null;
    const model = typeof raw.model === "string" ? raw.model : null;
    if (Number.isNaN(timestamp) || !provider || !model) continue;

    const day = new Date(timestamp).toISOString().slice(0, 10);
    const projectKey = projectLabel(raw.project);
    const key = day + " " + provider + " " + projectKey + " " + model;
    let row = buckets.get(key);
    if (!row) {
      row = {
        day,
        provider,
        projectKey,
        model,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        apiCalls: 0,
        sessions: 0,
        costUsd: 0,
        sessionIds: new Set<string>(),
      };
      buckets.set(key, row);
    }
    row.inputTokens += count(raw.inputTokens);
    row.outputTokens += count(raw.outputTokens);
    row.cacheReadTokens += count(raw.cacheReadTokens);
    row.cacheWriteTokens += count(raw.cacheWriteTokens);
    row.costUsd += count(raw.cost);
    row.apiCalls += 1;
    if (typeof raw.sessionId === "string") row.sessionIds.add(raw.sessionId);
  }

  return [...buckets.values()].map(({ sessionIds, ...row }) => ({
    ...row,
    sessions: sessionIds.size,
    // 成本累加后收敛到 6 位小数，免得浮点尾数一路带到服务端的 numeric(14,6)
    costUsd: Math.round(row.costUsd * 1e6) / 1e6,
  }));
}

/**
 * 项目路径脱敏：只保留最后一段目录名。
 *
 * codeburn 的 `project` 是本机绝对路径，直接上报等于把用户的目录结构（含用户名、
 * 客户名、项目代号）送到服务端。最后一段既足以辨认「哪个项目」，又不泄露其余层级。
 */
function projectLabel(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) return "";
  const segments = value
    .split("/")
    .flatMap((part) => part.split("\\"))
    .filter(Boolean);
  return segments.length > 0 ? segments[segments.length - 1].slice(0, 200) : "";
}
