/**
 * 采集器 id → 流水账 provider 的**显式**映射（#143 穿透用）。
 *
 * 不按名字猜：collectorId 与 provider 的命名并不一致（`claude-code` → `claude`、
 * `kimi-code` → `kimi`），去前缀之类的规则迟早会撞上反例。映射缺失时穿透入口
 * 直接不显示，而不是跳进一个筛不出东西的空页面。
 */
const COLLECTOR_TO_PROVIDER: Record<string, string> = {
  "claude-code": "claude",
  codex: "codex",
  "kimi-code": "kimi",
};

export function providerForCollector(collectorId: string | null): string | null {
  if (!collectorId) return null;
  return COLLECTOR_TO_PROVIDER[collectorId] ?? null;
}

/** 额度卡 → 消耗页：预置来源与该配额周期的时间窗。 */
export function spendHref(
  collectorId: string | null,
  period: { start: Date | null; end: Date | null },
): string | null {
  const provider = providerForCollector(collectorId);
  if (!provider) return null;
  const params = new URLSearchParams({ provider });
  if (period.start) params.set("from", period.start.toISOString().slice(0, 10));
  if (period.end) params.set("to", period.end.toISOString().slice(0, 10));
  return `/spend?${params.toString()}`;
}
