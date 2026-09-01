import { db } from "@/server/db";
import { dateKey, localToday } from "@/server/billing/local-date";

/**
 * 「消耗」页的聚合查询（#143）。
 *
 * 与配额仪表盘彼此独立：本模块不读 UsageQuota，配额页也不读本表。任一侧没有数据时
 * 另一侧照常工作 —— 只装了采集器没建订阅额度的用户能看消耗，没有消耗数据的用户
 * 额度卡照旧。
 */

export interface LedgerFilter {
  /** 穿透用：只看某个来源。 */
  provider?: string;
  /** 穿透用：限定时间窗（含首尾，按本地日期）。 */
  from?: string;
  to?: string;
}

export interface LedgerTotals {
  tokens: number;
  costUsd: number;
  savedUsd: number;
  apiCalls: number;
  /**
   * 推理 token。**不计入 tokens**：本机实测 codex 与 opencode 的 reasoning 小于
   * 同批 output（比值 0.34 / 0.55），是 output 的子集；而 grok 的 reasoning 是
   * output 的 8 倍，只能是独立计量。两种语义混在一个来源里，加进总和就会把占绝大
   * 多数的 codex 记录算重。单独列出来，不替用户合并。
   */
  reasoningTokens: number;
}

export interface LedgerBreakdownRow extends LedgerTotals {
  key: string;
  /** 占总成本的比例，0–100；总成本为 0 时按 token 占比。 */
  sharePct: number;
}

export interface LedgerSessionRow {
  sessionId: string;
  projectKey: string;
  provider: string;
  startedAt: Date;
  costUsd: number;
  savedUsd: number;
  apiCalls: number;
  turns: number;
}

export interface LedgerToolRow {
  name: string;
  calls: number;
  sharePct: number;
}

export interface LedgerModelQualityRow {
  model: string;
  costUsd: number;
  sharePct: number;
  apiCalls: number;
  editTurns: number;
  oneShotRatePct: number;
  retriesPerEdit: number;
  costPerEditUsd: number;
}

export interface LedgerView {
  totals: LedgerTotals;
  /**
   * 会话数。**不能**把按日聚合行里的 sessions 相加：同一个会话会横跨多天、多模型、
   * 多个任务分类的行，逐行相加会重复计数（本机实测 32 个会话被加成 220）。
   * 唯一可信的来源是会话快照表里的行数。
   */
  sessionCount: number;
  byProvider: LedgerBreakdownRow[];
  byModel: LedgerBreakdownRow[];
  byProject: LedgerBreakdownRow[];
  /** codeburn 的任务分类维度：钱花在写代码、调试还是闲聊上。 */
  byCategory: LedgerBreakdownRow[];
  daily: Array<{ day: string; tokens: number; costUsd: number }>;
  /** 每会话明细，按成本降序。 */
  sessions: LedgerSessionRow[];
  tools: LedgerToolRow[];
  mcp: LedgerToolRow[];
  modelQuality: LedgerModelQualityRow[];
  /**
   * 后三块（tools / mcp / modelQuality）是 30 天窗口快照，源头就没有 provider 与
   * 日期维度，**不随筛选变化**。页面必须把这件事说出来，否则用户会以为筛选生效了。
   */
  snapshotUnfiltered: boolean;
  /** 数据的最新采集时刻；为空表示从未上报过。 */
  lastCapturedAt: Date | null;
}

/** 默认窗口：最近 30 天（含今天）。 */
export function defaultRange(timezone: string, now: Date = new Date()): { from: string; to: string } {
  const to = dateKey(localToday(now, timezone));
  const from = dateKey(localToday(new Date(now.getTime() - 29 * 86_400_000), timezone));
  return { from, to };
}

export async function loadLedgerView(
  userId: string,
  timezone: string,
  filter: LedgerFilter = {},
  now: Date = new Date(),
): Promise<LedgerView> {
  const range = defaultRange(timezone, now);
  const from = filter.from ?? range.from;
  const to = filter.to ?? range.to;
  const fromDate = new Date(`${from}T00:00:00Z`);
  const toDate = new Date(`${to}T00:00:00Z`);

  const [rows, sessionRows, toolRows, qualityRows, sessionCount] = await Promise.all([
    db.usageLedgerDay.findMany({
      where: {
        userId,
        day: { gte: fromDate, lte: toDate },
        ...(filter.provider ? { provider: filter.provider } : {}),
      },
      orderBy: { day: "asc" },
    }),
    // 会话有 provider 与开始时间，因此跟随筛选；下面两张表没有这两个维度
    db.usageLedgerSession.findMany({
      where: {
        userId,
        startedAt: { gte: fromDate, lte: new Date(toDate.getTime() + 86_400_000) },
        ...(filter.provider ? { provider: filter.provider } : {}),
      },
      orderBy: { costUsd: "desc" },
      take: 100,
    }),
    db.usageToolStat.findMany({ where: { userId }, orderBy: { calls: "desc" } }),
    db.usageModelQuality.findMany({ where: { userId }, orderBy: { costUsd: "desc" } }),
    // 与上面的会话查询同筛选条件，但不受 take 上限影响
    db.usageLedgerSession.count({
      where: {
        userId,
        startedAt: { gte: fromDate, lte: new Date(toDate.getTime() + 86_400_000) },
        ...(filter.provider ? { provider: filter.provider } : {}),
      },
    }),
  ]);

  const totals = emptyTotals();
  const byProvider = new Map<string, LedgerTotals>();
  const byModel = new Map<string, LedgerTotals>();
  const byProject = new Map<string, LedgerTotals>();
  const byCategory = new Map<string, LedgerTotals>();
  const daily = new Map<string, { tokens: number; costUsd: number }>();
  let lastCapturedAt: Date | null = null;

  for (const row of rows) {
    const measure: LedgerTotals = {
      tokens:
        Number(row.inputTokens) +
        Number(row.outputTokens) +
        Number(row.cacheReadTokens) +
        Number(row.cacheWriteTokens),
      costUsd: Number(row.costUsd),
      savedUsd: Number(row.savedUsd),
      apiCalls: row.apiCalls,
      reasoningTokens: Number(row.reasoningTokens),
    };
    add(totals, measure);
    add(bucket(byProvider, row.provider), measure);
    add(bucket(byModel, row.model), measure);
    // 无项目维度的来源上报空串，归到「未标注」而不是凭空造一个项目名
    add(bucket(byProject, row.projectKey || "未标注"), measure);
    add(bucket(byCategory, row.category || "未分类"), measure);

    const key = row.day.toISOString().slice(0, 10);
    const d = daily.get(key) ?? { tokens: 0, costUsd: 0 };
    d.tokens += measure.tokens;
    d.costUsd += measure.costUsd;
    daily.set(key, d);

    if (lastCapturedAt === null || row.capturedAt > lastCapturedAt) lastCapturedAt = row.capturedAt;
  }

  return {
    totals,
    sessionCount,
    byProvider: rank(byProvider, totals),
    byModel: rank(byModel, totals),
    byProject: rank(byProject, totals),
    byCategory: rank(byCategory, totals),
    daily: [...daily.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, v]) => ({ day, ...v })),
    sessions: sessionRows.map((row) => ({
      sessionId: row.sessionId,
      projectKey: row.projectKey,
      provider: row.provider,
      startedAt: row.startedAt,
      costUsd: Number(row.costUsd),
      savedUsd: Number(row.savedUsd),
      apiCalls: row.apiCalls,
      turns: row.turns,
    })),
    tools: toolRows.filter((r) => r.kind === "tool").map(toolRow),
    mcp: toolRows.filter((r) => r.kind === "mcp").map(toolRow),
    modelQuality: qualityRows.map((row) => ({
      model: row.model,
      costUsd: Number(row.costUsd),
      sharePct: Number(row.sharePct),
      apiCalls: row.apiCalls,
      editTurns: row.editTurns,
      oneShotRatePct: Number(row.oneShotRatePct),
      retriesPerEdit: Number(row.retriesPerEdit),
      costPerEditUsd: Number(row.costPerEditUsd),
    })),
    snapshotUnfiltered: Boolean(filter.provider || filter.from || filter.to),
    lastCapturedAt,
  };
}

function toolRow(row: { name: string; calls: number; sharePct: unknown }): LedgerToolRow {
  return { name: row.name, calls: row.calls, sharePct: Number(row.sharePct) };
}

function emptyTotals(): LedgerTotals {
  return {
    tokens: 0,
    costUsd: 0,
    savedUsd: 0,
    apiCalls: 0,
    reasoningTokens: 0,
  };
}

function bucket(map: Map<string, LedgerTotals>, key: string): LedgerTotals {
  const existing = map.get(key);
  if (existing) return existing;
  const created = emptyTotals();
  map.set(key, created);
  return created;
}

function add(target: LedgerTotals, source: LedgerTotals): void {
  target.tokens += source.tokens;
  target.costUsd += source.costUsd;
  target.savedUsd += source.savedUsd;
  target.apiCalls += source.apiCalls;
  target.reasoningTokens += source.reasoningTokens;
}

function rank(map: Map<string, LedgerTotals>, totals: LedgerTotals): LedgerBreakdownRow[] {
  // 成本全为 0 时（价格表缺该模型）按 token 算占比，否则整列都是 0 看不出差别
  const basis = totals.costUsd > 0 ? "costUsd" : "tokens";
  const denominator = totals[basis];
  return [...map.entries()]
    .map(([key, value]) => ({
      key,
      ...value,
      sharePct: denominator > 0 ? (value[basis] / denominator) * 100 : 0,
    }))
    .sort((a, b) => b[basis] - a[basis]);
}
