import { redirect } from "next/navigation";

import { CategoryDonut, TrendChart } from "@/components/analytics-charts";
import { currentAppSession } from "@/server/auth/current-session";
import { db } from "@/server/db";
import {
  categoryBreakdown,
  dashboardStats,
  monthlyTrend,
} from "@/server/billing/stats";

export const dynamic = "force-dynamic";

export default async function AnalyticsPage() {
  const session = await currentAppSession();
  if (!session) redirect("/login");

  const user = await db.user.findUnique({
    where: { id: session.userId },
    select: { baseCurrency: true },
  });
  const baseCurrency = user?.baseCurrency ?? "CNY";

  const [stats, trend, categories] = await Promise.all([
    dashboardStats(session.userId),
    monthlyTrend(session.userId),
    categoryBreakdown(session.userId),
  ]);

  return (
    <main className="shell">
      <p className="eyebrow">花费统计</p>
      <h1>统计与趋势</h1>

      {stats.incomplete && (
        <p className="form-error" role="alert">
          {stats.missingProjections} 条已付记录缺少 {baseCurrency} 投影，未计入「实际已付」
          （不会按 0 统计，补齐汇率后自动入账）。
        </p>
      )}

      <h2>近 12 个月（{baseCurrency}）</h2>
      <p className="field-hint">
        「预计将付」按最新汇率估算（design §7.3），与实际扣费日的汇率可能存在偏差
        {trend.some((m) => m.pendingUncovered) && "；部分币种缺汇率未计入"}
      </p>
      <TrendChart data={trend} currency={baseCurrency} />

      <h2>分类占比（年化，{baseCurrency}）</h2>
      <p className="field-hint">
        口径同总览页年化成本：只计试用与启用中的订阅{categories.uncovered && "；部分币种缺汇率未计入"}
      </p>
      <CategoryDonut data={categories.slices} currency={baseCurrency} />
    </main>
  );
}
