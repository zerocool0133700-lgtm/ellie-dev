/**
 * UMS Consumer: Calendar Intelligence
 *
 * ELLIE-309: Push subscriber — analyzes calendar events for conflicts,
 * prep tasks, and schedule patterns.
 *
 * Listens to: calendar events
 * Action: detects conflicts, generates prep reminders, flags schedule issues
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { UnifiedMessage } from "../types.ts";
import { subscribe } from "../events.ts";
import { log } from "../../logger.ts";

const logger = log.child("ums-consumer-calendar-intel");

/** How far ahead to look for conflicts (ms). */
const CONFLICT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** Meetings that need prep if they have many attendees. */
const LARGE_MEETING_THRESHOLD = 5;

export interface CalendarInsight {
  type: "conflict" | "prep_needed" | "busy_day" | "back_to_back";
  severity: "info" | "warning" | "alert";
  message: string;
  event_id: string | null;
  metadata: Record<string, unknown>;
}

/** Accumulated insights from calendar events. */
const insights: CalendarInsight[] = [];

/**
 * Initialize the Calendar Intel consumer.
 */
export function initCalendarIntelConsumer(supabase: SupabaseClient): void {
  subscribe("consumer:calendar-intel", { content_type: "event" }, async (message) => {
    try {
      await handleMessage(supabase, message);
    } catch (err) {
      logger.error("Calendar Intel consumer failed", { messageId: message.id, err });
    }
  });
  logger.info("Calendar Intel consumer initialized");
}

async function handleMessage(_supabase: SupabaseClient, message: UnifiedMessage): Promise<void> {
  if (message.provider !== "calendar") return;

  const meta = message.metadata || {};
  const eventId = (meta.event_id || message.provider_id) as string;

  // Check for large meetings needing prep
  checkPrepNeeded(message, eventId, meta);

  // Check for back-to-back or busy patterns
  checkSchedulePatterns(message, eventId, meta);
}

function checkPrepNeeded(
  message: UnifiedMessage,
  eventId: string,
  meta: Record<string, unknown>,
): void {
  const attendeeCount = (meta.attendee_count as number) || 0;
  const title = (meta.title as string) || message.content || "";

  // Large meetings need prep
  if (attendeeCount >= LARGE_MEETING_THRESHOLD) {
    addInsight({
      type: "prep_needed",
      severity: "info",
      message: `Large meeting (${attendeeCount} attendees): "${title}" — consider preparing an agenda`,
      event_id: eventId,
      metadata: { attendee_count: attendeeCount, title },
    });
  }

  // Meetings with "review", "demo", "presentation" in title need prep
  const prepKeywords = /\b(review|demo|presentation|interview|pitch|standup)\b/i;
  if (prepKeywords.test(title)) {
    addInsight({
      type: "prep_needed",
      severity: "info",
      message: `"${title}" may need preparation`,
      event_id: eventId,
      metadata: { title, matched_keyword: true },
    });
  }
}

function checkSchedulePatterns(
  message: UnifiedMessage,
  eventId: string,
  meta: Record<string, unknown>,
): void {
  const startTime = meta.start_time as string;
  if (!startTime) return;

  const start = new Date(startTime);
  const now = new Date();

  // Flag same-day changes to events happening soon (< 2 hours)
  const hoursUntil = (start.getTime() - now.getTime()) / (1000 * 60 * 60);
  if (hoursUntil > 0 && hoursUntil < 2 && meta.change_type) {
    addInsight({
      type: "conflict",
      severity: "warning",
      message: `Upcoming event changed: "${meta.title || message.content}" starts in ${Math.round(hoursUntil * 60)} minutes`,
      event_id: eventId,
      metadata: { hours_until: hoursUntil, change_type: meta.change_type },
    });
  }
}

function addInsight(insight: CalendarInsight): void {
  // Dedup by event_id + type
  const existing = insights.findIndex(
    i => i.event_id === insight.event_id && i.type === insight.type
  );
  if (existing >= 0) {
    insights[existing] = insight;
  } else {
    insights.push(insight);
  }

  // Cap at 100 insights
  if (insights.length > 100) insights.splice(0, insights.length - 100);

  logger.debug("Calendar insight added", { type: insight.type, severity: insight.severity });
}

/** Get all current calendar insights. Called by briefing or on-demand. */
export function getCalendarInsights(): CalendarInsight[] {
  return [...insights];
}

/** Get only alerts/warnings. */
export function getCalendarAlerts(): CalendarInsight[] {
  return insights.filter(i => i.severity !== "info");
}

/** Clear insights (e.g., after daily briefing consumes them). */
export function clearInsights(): void {
  insights.length = 0;
}
