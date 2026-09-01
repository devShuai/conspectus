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

/**
 * 同一次导出的完整聚合，供流水账上报（#143）。
 *
 * provider 默认 `all`：codeburn 支持 41 个工具，本机实测就有 codex / grok / claude /
 * opencode / kimicode / copilot 六个在产出数据。只导 claude 会把其余五个的消耗全部
 * 丢掉 —— 0.4.0 正是这么干的。
 */
export async function runCodeburnLedger(
  provider = "all",
  options: { entry?: string; timeoutMs?: number } = {},
): Promise<CodeburnLedger | null> {
  return aggregateCodeburnExport(await exportRaw(provider, options));
}

/**
 * 上报给服务端的按日聚合行（与服务端 LedgerDaySchema 对齐）。
 *
 * 维度取齐 codeburn 的口径：除日期 / 来源 / 项目 / 模型外，还带 **任务分类**
 * （codeburn 的招牌维度，coding / debugging / delegation …）与 **子代理类型**。
 * 实测 31277 条明细压成 213 行，仍是 147 倍压缩，明细继续留在本机由 codeburn 保管。
 */
export interface LedgerDayRow {
  day: string;
  provider: string;
  projectKey: string;
  model: string;
  /** codeburn 的任务分类；缺失时空串。 */
  category: string;
  /** 委派给子代理时的代理类型；无则空串。 */
  subagent: string;
  inputTokens: number;
  outputTokens: number;
  /** 推理 token。本机 31277 条里 20556 条非零，丢掉等于漏计 codex/grok 的大头。 */
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  apiCalls: number;
  sessions: number;
  costUsd: number;
  /** 本地模型 / 订阅代理折算出的「省下多少」，codeburn 与成本分开记。 */
  savedUsd: number;
}

/** 每会话明细：codeburn 的 sessions 表，30 天窗口内数十行。 */
export interface LedgerSessionRow {
  sessionId: string;
  projectKey: string;
  /** sessions 表本身不带 provider，由 records 按 sessionId 反查补上。 */
  provider: string;
  startedAt: string;
  costUsd: number;
  savedUsd: number;
  apiCalls: number;
  turns: number;
}

/** 工具与 MCP 的调用分布。 */
export interface LedgerToolRow {
  kind: "tool" | "mcp";
  name: string;
  calls: number;
  sharePct: number;
}

/** 按模型的质量指标：codeburn 用来回答「贵的模型是不是真的更省事」。 */
export interface LedgerModelQualityRow {
  /** codeburn 的展示名（如 `Opus 5`），与流水账里的原始 id 不是一个东西。 */
  model: string;
  costUsd: number;
  savedUsd: number;
  sharePct: number;
  apiCalls: number;
  editTurns: number;
  oneShotRatePct: number;
  retriesPerEdit: number;
  costPerEditUsd: number;
}

export interface CodeburnLedger {
  generatedAt: Date;
  /** codeburn 的展示币种。非 USD 时下面的金额已按 rate 还原成 USD。 */
  sourceCurrency: string;
  days: LedgerDayRow[];
  sessions: LedgerSessionRow[];
  tools: LedgerToolRow[];
  models: LedgerModelQualityRow[];
}

/**
 * 把一次 `codeburn export --format json` 的产物聚合成上报载荷。
 *
 * **不上报 shellCommands**。codeburn 会导出 721 条 shell 命令原文，里面常见绝对
 * 路径、主机名、工单号，偶尔还有命令行参数里的密钥 —— 那是 §9 脱敏纪律明确不许出
 * 本机的东西。工具名（Bash/Edit/Read）与 MCP 服务器名不含这类内容，照常上报。
 *
 * 金额一律还原成 USD：codeburn 导出时把 cost 按展示币种换算过
 * （其源码 `convertCost = costUSD * rate`），照抄会让设了 GBP 的用户把英镑写进
 * costUsd 列。
 */
export function aggregateCodeburnExport(text: string): CodeburnLedger | null {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(body) || body.schema !== SUPPORTED_SCHEMA) return null;

  const currency = isRecord(body.currency) ? body.currency : {};
  const sourceCurrency = typeof currency.code === "string" ? currency.code : "USD";
  const rate = typeof currency.rate === "number" && currency.rate > 0 ? currency.rate : 1;
  const usd = (value: unknown): number => round6(count(value) / rate);

  const generated = typeof body.generated === "string" ? Date.parse(body.generated) : Number.NaN;
  const records = Array.isArray(body.records) ? body.records : [];

  return {
    generatedAt: Number.isNaN(generated) ? new Date() : new Date(generated),
    sourceCurrency,
    days: aggregateDays(records, usd),
    sessions: aggregateSessions(body.sessions, sessionProviders(records), usd),
    tools: aggregateTools(body.tools, body.mcp),
    models: aggregateModelQuality(body.periods, usd),
  };
}

/** 兼容旧调用点：只要按日聚合那部分。 */
export function aggregateCodeburnRecords(text: string): LedgerDayRow[] | null {
  return aggregateCodeburnExport(text)?.days ?? null;
}

/**
 * 是否是「一次真实 API 调用」。codeburn 的 records 是原始账本，掺有补充记账行，
 * 它自己的注释写明「a one row per API call consumer」要靠 `supplementary` 区分。
 * 不过滤就会把调用次数和成本一起算重。
 */
function isApiCall(raw: Record<string, unknown>): boolean {
  return raw.supplementary !== true;
}

function aggregateDays(records: unknown[], usd: (value: unknown) => number): LedgerDayRow[] {
  const buckets = new Map<string, LedgerDayRow & { sessionIds: Set<string> }>();
  for (const raw of records) {
    if (!isRecord(raw) || !isApiCall(raw)) continue;
    const timestamp = typeof raw.timestamp === "string" ? Date.parse(raw.timestamp) : Number.NaN;
    const provider = typeof raw.provider === "string" ? raw.provider : null;
    const model = typeof raw.model === "string" ? raw.model : null;
    if (Number.isNaN(timestamp) || !provider || !model) continue;

    const day = new Date(timestamp).toISOString().slice(0, 10);
    const projectKey = projectLabel(raw.project);
    const category = text64(raw.category);
    const subagent = text64(raw.subagentType);
    const key = [day, provider, projectKey, model, category, subagent].join(" ");
    let row = buckets.get(key);
    if (!row) {
      row = {
        day,
        provider,
        projectKey,
        model,
        category,
        subagent,
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        apiCalls: 0,
        sessions: 0,
        costUsd: 0,
        savedUsd: 0,
        sessionIds: new Set<string>(),
      };
      buckets.set(key, row);
    }
    row.inputTokens += count(raw.inputTokens);
    row.outputTokens += count(raw.outputTokens);
    row.reasoningTokens += count(raw.reasoningTokens);
    row.cacheReadTokens += count(raw.cacheReadTokens);
    row.cacheWriteTokens += count(raw.cacheWriteTokens);
    row.costUsd += usd(raw.cost);
    row.savedUsd += usd(raw.savings);
    row.apiCalls += 1;
    if (typeof raw.sessionId === "string") row.sessionIds.add(raw.sessionId);
  }

  return [...buckets.values()].map(({ sessionIds, ...row }) => ({
    ...row,
    sessions: sessionIds.size,
    // 累加后收敛到 6 位小数，免得浮点尾数一路带到服务端的 numeric(14,6)
    costUsd: round6(row.costUsd),
    savedUsd: round6(row.savedUsd),
  }));
}

/** sessions 表不带 provider，用 records 反查；一个会话跨多 provider 时取首个。 */
function sessionProviders(records: unknown[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const raw of records) {
    if (!isRecord(raw)) continue;
    const id = typeof raw.sessionId === "string" ? raw.sessionId : null;
    const provider = typeof raw.provider === "string" ? raw.provider : null;
    if (id && provider && !map.has(id)) map.set(id, provider);
  }
  return map;
}

function aggregateSessions(
  value: unknown,
  providerBySession: Map<string, string>,
  usd: (value: unknown) => number,
): LedgerSessionRow[] {
  if (!Array.isArray(value)) return [];
  const rows: LedgerSessionRow[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    const sessionId = typeof raw["Session ID"] === "string" ? raw["Session ID"] : null;
    const startedAt = typeof raw["Started At"] === "string" ? raw["Started At"] : null;
    if (!sessionId || !startedAt || Number.isNaN(Date.parse(startedAt))) continue;
    rows.push({
      sessionId: sessionId.slice(0, 128),
      projectKey: projectLabel(raw.Project),
      provider: providerBySession.get(sessionId) ?? "",
      startedAt: new Date(startedAt).toISOString(),
      costUsd: usd(raw["Cost (USD)"]),
      savedUsd: usd(raw["Saved (USD)"]),
      apiCalls: count(raw["API Calls"]),
      turns: count(raw.Turns),
    });
  }
  return rows;
}

function aggregateTools(tools: unknown, mcp: unknown): LedgerToolRow[] {
  const rows: LedgerToolRow[] = [];
  const collect = (value: unknown, kind: "tool" | "mcp", field: string): void => {
    if (!Array.isArray(value)) return;
    for (const raw of value) {
      if (!isRecord(raw)) continue;
      const source = raw[field];
      const name = typeof source === "string" ? source.slice(0, 128) : null;
      if (!name) continue;
      rows.push({ kind, name, calls: count(raw.Calls), sharePct: count(raw["Share (%)"]) });
    }
  };
  collect(tools, "tool", "Tool");
  collect(mcp, "mcp", "Server");
  return rows;
}

/** 质量指标只取 30 天周期：日/周两档窗口太短，One-shot Rate 之类会剧烈抖动。 */
function aggregateModelQuality(
  periods: unknown,
  usd: (value: unknown) => number,
): LedgerModelQualityRow[] {
  if (!Array.isArray(periods) || periods.length === 0) return [];
  const period = periods[periods.length - 1];
  if (!isRecord(period) || !Array.isArray(period.models)) return [];
  const rows: LedgerModelQualityRow[] = [];
  for (const raw of period.models) {
    if (!isRecord(raw)) continue;
    const model = typeof raw.Model === "string" ? raw.Model.slice(0, 128) : null;
    if (!model) continue;
    rows.push({
      model,
      costUsd: usd(raw["Cost (USD)"]),
      savedUsd: usd(raw["Saved (USD)"]),
      sharePct: count(raw["Share (%)"]),
      apiCalls: count(raw["API Calls"]),
      editTurns: count(raw["Edit Turns"]),
      oneShotRatePct: count(raw["One-shot Rate (%)"]),
      retriesPerEdit: count(raw["Retries/Edit"]),
      costPerEditUsd: usd(raw["Cost/Edit (USD)"]),
    });
  }
  return rows;
}

function count(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function text64(value: unknown): string {
  return typeof value === "string" ? value.slice(0, 64) : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
