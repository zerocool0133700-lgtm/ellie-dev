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
