/**
 * Calendar-date helpers for billing (design.md §7.2).
 *
 * Billing dates are `@db.Date` columns, i.e. a calendar date materialised at
 * UTC midnight. "Today" must be resolved in the *user's* timezone, otherwise a
 * UTC+8 user's charge only appears after 08:00 local and a UTC-8 user's shows
 * up the previous evening.
 */

/** Widest civil offset in use (UTC+14), used to size the candidate window. */
export const MAX_TZ_OFFSET_MS = 14 * 60 * 60 * 1000;

/**
 * The user's current calendar date, as a Date at UTC midnight so it compares
 * directly against `@db.Date` columns.
 */
export function localToday(now: Date, timeZone: string): Date {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now);
  } catch {
    // Unknown IANA zone (bad data / renamed zone): fall back to UTC rather
    // than throwing and stalling the whole runner for every other user.
    return new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
  }
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return new Date(Date.UTC(get("year"), get("month") - 1, get("day")));
}

/** `YYYY-MM-DD` of a `@db.Date` value; timezone-independent by construction. */
export function dateKey(value: Date): string {
  return value.toISOString().slice(0, 10);
}
