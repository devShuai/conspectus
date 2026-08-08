"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { formatMoney } from "@/components/money";
import type { CategorySlice, TrendMonth } from "@/server/billing/stats";

const CATEGORY_LABELS: Record<string, string> = {
  streaming: "流媒体",
  ai: "AI",
  cloud: "云服务",
  dev_tool: "开发工具",
  storage: "存储",
  domain: "域名",
  music: "音乐",
  news: "新闻",
  game: "游戏",
  other: "其他",
  uncategorized: "未分类",
};

function monthLabel(month: string): string {
  const [, m] = month.split("-");
  return `${Number(m)}月`;
}

/** 近 12 个月趋势：实际已付 vs 预计将付（design §7.8，两组序列不合并）。 */
export function TrendChart({ data, currency }: Readonly<{ data: TrendMonth[]; currency: string }>) {
  const rows = data.map((m) => ({
    ...m,
    label: monthLabel(m.month),
    paid: Math.round(m.paid * 100) / 100,
    pending: Math.round(m.pending * 100) / 100,
  }));
  return (
    <div style={{ width: "100%", height: 280 }}>
      <ResponsiveContainer>
        <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="label" fontSize={12} />
          <YAxis fontSize={12} width={70} />
          <Tooltip
            formatter={(value) => [formatMoney(Number(value), currency), undefined]}
          />
          <Legend />
          <Bar dataKey="paid" name="实际已付" fill="var(--brand-accent)" radius={[3, 3, 0, 0]} />
          <Bar
            dataKey="pending"
            name="预计将付（按最新汇率估算）"
            fill="var(--brand-muted)"
            fillOpacity={0.55}
            radius={[3, 3, 0, 0]}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

const SLICE_FILLS = [
  { fill: "var(--brand-accent)", opacity: 1 },
  { fill: "var(--brand-ink)", opacity: 0.85 },
  { fill: "var(--brand-muted)", opacity: 0.9 },
  { fill: "var(--brand-accent)", opacity: 0.55 },
  { fill: "var(--brand-ink)", opacity: 0.55 },
  { fill: "var(--brand-muted)", opacity: 0.55 },
  { fill: "var(--brand-accent)", opacity: 0.35 },
  { fill: "var(--brand-ink)", opacity: 0.35 },
  { fill: "var(--brand-muted)", opacity: 0.4 },
  { fill: "var(--brand-accent)", opacity: 0.25 },
];

/** 分类占比环形图：按 Vendor.category 的年化成本。 */
export function CategoryDonut({
  data,
  currency,
}: Readonly<{ data: CategorySlice[]; currency: string }>) {
  const rows = data.map((s) => ({
    name: CATEGORY_LABELS[s.category] ?? s.category,
    value: Math.round(s.annualized * 100) / 100,
  }));
  if (rows.length === 0) {
    return <p className="muted">暂无启用中的订阅。</p>;
  }
  return (
    <div style={{ width: "100%", height: 280 }}>
      <ResponsiveContainer>
        <PieChart>
          <Pie
            data={rows}
            dataKey="value"
            nameKey="name"
            innerRadius={64}
            outerRadius={100}
            paddingAngle={2}
          >
            {rows.map((row, index) => {
              const style = SLICE_FILLS[index % SLICE_FILLS.length];
              return (
                <Cell
                  key={row.name}
                  fill={style.fill}
                  fillOpacity={style.opacity}
                />
              );
            })}
          </Pie>
          <Tooltip formatter={(value) => [`${formatMoney(Number(value), currency)} / 年`, undefined]} />
          <Legend />
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}
