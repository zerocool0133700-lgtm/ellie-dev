/**
 * Timezone Utilities — Single source of truth
 *
 * All timezone-aware date operations should use these helpers
 * instead of raw toISOString().split("T")[0] (which gives UTC dates).
 */

/** User's configured timezone, with system fallback */
export const USER_TIMEZONE =
  process.env.USER_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone;

/**
 * Get today's date as YYYY-MM-DD in the user's timezone.
 * Avoids the UTC off-by-one after 6pm CST.
 */
export function getToday(tz: string = USER_TIMEZONE): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: tz });
}

/**
 * Get a date string (YYYY-MM-DD) for a given timestamp in the user's timezone.
 */
export function toDateString(
  date: Date | string | number,
  tz: string = USER_TIMEZONE,
): string {
  return new Date(date).toLocaleDateString("en-CA", { timeZone: tz });
}

/**
 * Format a time string like "2:30 PM" in the user's timezone.
 */
export function formatTime(
  date: Date | string | number,
  tz: string = USER_TIMEZONE,
): string {
  return new Date(date).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: tz,
  });
}

/**
 * Format a short time like "02:30" (24h) in the user's timezone.
 */
export function formatTime24(
  date: Date | string | number,
  tz: string = USER_TIMEZONE,
): string {
  return new Date(date).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: tz,
  });
}

/**
 * Format a full date+time like "Mar 16, 2026, 9:41 PM" in the user's timezone.
 */
export function formatDateTime(
  date: Date | string | number,
  tz: string = USER_TIMEZONE,
): string {
  return new Date(date).toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: tz,
  });
}

/**
 * Format a short date like "Mar 16" in the user's timezone.
 */
export function formatDateShort(
  date: Date | string | number,
  tz: string = USER_TIMEZONE,
): string {
  return new Date(date).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: tz,
  });
}

/**
 * Format a full date like "Sunday, March 16, 2026" in the user's timezone.
 */
export function formatDateFull(
  date: Date | string | number,
  tz: string = USER_TIMEZONE,
): string {
  return new Date(date).toLocaleDateString("en-US", {
    dateStyle: "full",
    timeZone: tz,
  });
}

/**
 * Format a relative-ish display: "today at 2:30 PM", "yesterday at 9:00 AM", or "Mar 14 at 11:00 AM"
 */
export function formatRelativeDateTime(
  date: Date | string | number,
  tz: string = USER_TIMEZONE,
): string {
  const d = new Date(date);
  const todayStr = getToday(tz);
  const dateStr = toDateString(d, tz);
  const timeStr = formatTime(d, tz);

  if (dateStr === todayStr) return `today at ${timeStr}`;

  const yesterday = new Date(Date.now() - 86400000);
  const yesterdayStr = toDateString(yesterday, tz);
  if (dateStr === yesterdayStr) return `yesterday at ${timeStr}`;

  return `${formatDateShort(d, tz)} at ${timeStr}`;
}
