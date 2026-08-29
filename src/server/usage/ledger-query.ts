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
  apiCalls: number;
  sessions: number;
}

export interface LedgerBreakdownRow extends LedgerTotals {
  key: string;
  /** 占总成本的比例，0–100；总成本为 0 时按 token 占比。 */
  sharePct: number;
}

export interface LedgerView {
  totals: LedgerTotals;
  byProvider: LedgerBreakdownRow[];
  byModel: LedgerBreakdownRow[];
  byProject: LedgerBreakdownRow[];
  daily: Array<{ day: string; tokens: number; costUsd: number }>;
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

  const rows = await db.usageLedgerDay.findMany({
    where: {
      userId,
      day: { gte: new Date(`${from}T00:00:00Z`), lte: new Date(`${to}T00:00:00Z`) },
      ...(filter.provider ? { provider: filter.provider } : {}),
    },
    orderBy: { day: "asc" },
  });

  const totals: LedgerTotals = { tokens: 0, costUsd: 0, apiCalls: 0, sessions: 0 };
  const byProvider = new Map<string, LedgerTotals>();
  const byModel = new Map<string, LedgerTotals>();
  const byProject = new Map<string, LedgerTotals>();
  const daily = new Map<string, { tokens: number; costUsd: number }>();
  let lastCapturedAt: Date | null = null;

  for (const row of rows) {
    const tokens =
      Number(row.inputTokens) +
      Number(row.outputTokens) +
      Number(row.cacheReadTokens) +
      Number(row.cacheWriteTokens);
    const cost = Number(row.costUsd);
    add(totals, tokens, cost, row.apiCalls, row.sessions);
    add(bucket(byProvider, row.provider), tokens, cost, row.apiCalls, row.sessions);
    add(bucket(byModel, row.model), tokens, cost, row.apiCalls, row.sessions);
    // 无项目维度的来源上报空串，归到「未标注」而不是凭空造一个项目名
    add(bucket(byProject, row.projectKey || "未标注"), tokens, cost, row.apiCalls, row.sessions);

    const key = row.day.toISOString().slice(0, 10);
    const d = daily.get(key) ?? { tokens: 0, costUsd: 0 };
    d.tokens += tokens;
    d.costUsd += cost;
    daily.set(key, d);

    if (lastCapturedAt === null || row.capturedAt > lastCapturedAt) lastCapturedAt = row.capturedAt;
  }

  return {
    totals,
    byProvider: rank(byProvider, totals),
    byModel: rank(byModel, totals),
    byProject: rank(byProject, totals),
    daily: [...daily.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, v]) => ({ day, ...v })),
    lastCapturedAt,
  };
}

function bucket(map: Map<string, LedgerTotals>, key: string): LedgerTotals {
  const existing = map.get(key);
  if (existing) return existing;
  const created: LedgerTotals = { tokens: 0, costUsd: 0, apiCalls: 0, sessions: 0 };
  map.set(key, created);
  return created;
}

function add(target: LedgerTotals, tokens: number, cost: number, calls: number, sessions: number): void {
  target.tokens += tokens;
  target.costUsd += cost;
  target.apiCalls += calls;
  target.sessions += sessions;
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
