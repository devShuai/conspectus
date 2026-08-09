/** 本地时刻 → UTC instant 的换算（通知排程用，design §7.6「本地 09:00 转换成 UTC scheduledAt」）。 */

import { localToday } from "@/server/billing/local-date";

function tzOffsetMs(timezone: string, at: Date): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = formatter.formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - at.getTime();
}

function localDateParts(timezone: string, at: Date): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { year: get("year"), month: get("month"), day: get("day") };
}

/**
 * from 之后的下一个「本地 hour:minute」（UTC instant）。
 * 时区解释只发生一次（§7.6）：夏令时切换与用户改时区都不回改已入队时间。
 */
export function nextLocalTime(
  from: Date,
  timezone: string,
  hour: number,
  minute: number = 0,
): Date {
  const { year, month, day } = localDateParts(timezone, from);
  for (let add = 0; add <= 1; add++) {
    const localMidnightUtc = Date.UTC(year, month - 1, day + add);
    const probe = new Date(localMidnightUtc + hour * 3_600_000 + minute * 60_000);
    const candidate = new Date(probe.getTime() - tzOffsetMs(timezone, probe));
    if (candidate > from) return candidate;
  }
  // 理论不可达（两天内必有下一个 hour:minute），保底 +24h
  return new Date(from.getTime() + 86_400_000);
}

/** 两个 UTC 日界之间的整天数差（按用户时区各自的「今天」对齐）。 */
export function localDaysBetween(from: Date, to: Date, timezone: string): number {
  return Math.round(
    (localToday(to, timezone).getTime() - localToday(from, timezone).getTime()) / 86_400_000,
  );
}
