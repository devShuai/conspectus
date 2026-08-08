import Link from "next/link";
import { redirect } from "next/navigation";

import { currentAppSession } from "@/server/auth/current-session";
import { db } from "@/server/db";
import { billingCalendar, type CalendarDay } from "@/server/billing/stats";

export const dynamic = "force-dynamic";

const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function shiftMonth(year: number, month: number, delta: number): { year: number; month: number } {
  const ref = new Date(Date.UTC(year, month - 1 + delta, 1));
  return { year: ref.getUTCFullYear(), month: ref.getUTCMonth() + 1 };
}

function currentMonthInTz(timezone: string): { year: number; month: number; todayKey: string } {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(now);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const year = get("year");
  const month = get("month");
  return {
    year,
    month,
    todayKey: `${year}-${String(month).padStart(2, "0")}-${String(get("day")).padStart(2, "0")}`,
  };
}

export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ year?: string; month?: string }>;
}) {
  const session = await currentAppSession();
  if (!session) redirect("/login");

  const user = await db.user.findUnique({
    where: { id: session.userId },
    select: { timezone: true, baseCurrency: true },
  });
  const now = currentMonthInTz(user?.timezone ?? "Asia/Shanghai");
  const params = await searchParams;
  const year = Number(params.year) || now.year;
  const month = Math.min(12, Math.max(1, Number(params.month) || now.month));

  const days = await billingCalendar(session.userId, year, month);
  const byDate = new Map<string, CalendarDay>(days.map((d) => [d.date, d]));

  const total = daysInMonth(year, month);
  const firstOffset = (new Date(Date.UTC(year, month - 1, 1)).getUTCDay() + 6) % 7; // 周一开头
  const prev = shiftMonth(year, month, -1);
  const next = shiftMonth(year, month, 1);

  const cells: Array<{ day: number; key: string } | null> = [];
  for (let i = 0; i < firstOffset; i++) cells.push(null);
  for (let d = 1; d <= total; d++) {
    cells.push({ day: d, key: `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}` });
  }

  return (
    <main className="shell">
      <p className="eyebrow">续费日历</p>
      <div className="cal-head">
        <h1>
          {year} 年 {month} 月
        </h1>
        <div className="actions">
          <Link className="button secondary" href={`/calendar?year=${prev.year}&month=${prev.month}`}>
            ← 上月
          </Link>
          <Link className="button secondary" href={`/calendar?year=${next.year}&month=${next.month}`}>
            下月 →
          </Link>
        </div>
      </div>

      <div className="cal-grid" role="grid">
        {WEEKDAYS.map((w) => (
          <div key={w} className="cal-weekday" role="columnheader">
            {w}
          </div>
        ))}
        {cells.map((cell, index) => {
          if (!cell) return <div key={`blank-${index}`} className="cal-cell cal-blank" />;
          const entry = byDate.get(cell.key);
          const subtotals = new Map<string, number>();
          for (const item of entry?.dueSubscriptions ?? []) {
            subtotals.set(item.currency, (subtotals.get(item.currency) ?? 0) + item.amount);
          }
          return (
            <div
              key={cell.key}
              className={`cal-cell${cell.key === now.todayKey ? " cal-today" : ""}`}
              role="gridcell"
            >
              <div className="cal-day">{cell.day}</div>
              {entry && (
                <>
                  <ul className="cal-items">
                    {entry.dueSubscriptions.map((item) => (
                      <li key={item.id}>
                        {item.name}
                        <span className="cal-amount">
                          {item.currency} {item.amount.toFixed(2)}
                        </span>
                      </li>
                    ))}
                  </ul>
                  <div className="cal-subtotal">
                    {[...subtotals.entries()].map(([currency, amount]) => (
                      <span key={currency}>
                        {currency} {amount.toFixed(2)}
                      </span>
                    ))}
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>
      <p className="field-hint">合计按币种分列；「预计将付」口径见总览页（design §7.3 / §7.8）</p>
    </main>
  );
}
