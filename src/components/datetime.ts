/**
 * 全站时间格式化（#78 / design §6.2 User.timezone）：
 * 服务端组件按用户时区渲染；en-CA 给出 YYYY-MM-DD HH:mm 的稳定排序格式，
 * h23 保证跨午夜是 00:xx 而不是 24:xx。非法时区回退 UTC（与改造前一致）。
 * 纯日期（nextBillingAt 等 date 列）保持 YYYY-MM-DD，不做时区偏移。
 */
export function formatDateTime(date: Date, timezone: string): string {
  return parts(date, timezone, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    // en-CA 在日期+时间分量间会插逗号，统一为空格
  }).replace(",", "");
}

/** 用户时区下的日历日（YYYY-MM-DD），用于「今天/某一天」语义而非 date 列原值。 */
export function formatDate(date: Date, timezone: string): string {
  return parts(date, timezone, { year: "numeric", month: "2-digit", day: "2-digit" });
}

function parts(
  date: Date,
  timezone: string,
  options: Intl.DateTimeFormatOptions,
): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      hourCycle: "h23",
      ...options,
    }).format(date);
  } catch {
    return parts(date, "UTC", options);
  }
}
