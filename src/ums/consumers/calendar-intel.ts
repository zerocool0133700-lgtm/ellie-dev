/**
 * UMS Consumer: Calendar Intelligence
 *
 * ELLIE-309: Push subscriber — analyzes calendar events for conflicts,
 * prep tasks, and schedule patterns.
 * ELLIE-319: DB persistence, conflict detection, prep tracking, pattern analysis
 * ELLIE-319 Phase 2: Auto-prep notes from Forest/Comms/UMS, conflict resolution suggestions
 *
 * Listens to: calendar events from UMS
 * Action: maintains DB-backed event intel, detects conflicts, generates prep needs
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { UnifiedMessage } from "../types.ts";
import { subscribe } from "../events.ts";
import { log } from "../../logger.ts";

const logger = log.child("ums-consumer-calendar-intel");

// ── Types ────────────────────────────────────────────────────

export interface CalendarInsight {
  type: "conflict" | "prep_needed" | "busy_day" | "back_to_back" | "focus_opportunity" | "high_density";
  severity: "info" | "warning" | "alert";
  message: string;
  event_id: string | null;
  metadata: Record<string, unknown>;
}

export interface CalendarIntelRow {
  id: string;
  event_id: string;
  provider: string;
  title: string;
  start_time: string;
  end_time: string | null;
  location: string | null;
  attendees: Array<{ email?: string; name?: string; responseStatus?: string }>;
  organizer: string | null;
  meeting_url: string | null;
  all_day: boolean;
  meeting_type: string;
  energy_cost: string;
  prep_status: string;
  prep_notes: string | null;
  prep_generated_at: string | null;
  has_conflict: boolean;
  conflict_with: string[];
  is_back_to_back: boolean;
  travel_warning: boolean;
  reviewed: boolean;
  reviewed_at: string | null;
  last_synced: string;
  created_at: string;
  updated_at: string;
}

export interface CalendarPattern {
  id: string;
  pattern_type: string;
  day_of_week: number | null;
  hour_of_day: number | null;
  data: Record<string, unknown>;
  sample_size: number;
  confidence: number;
  period_start: string | null;
  period_end: string | null;
}

// ── State ────────────────────────────────────────────────────

let supabaseRef: SupabaseClient | null = null;

/** In-memory cache of upcoming event intel (next 7 days). */
const intelCache = new Map<string, CalendarIntelRow>();

/** Accumulated insights (refreshed on sync). */
const insights: CalendarInsight[] = [];

/** Configurable preferences. */
let prefs = {
  prepKeywords: ["review", "demo", "presentation", "interview", "pitch", "standup", "retro", "planning", "1:1", "one on one"],
  largeMeetingThreshold: 5,
  backToBackMinutes: 15,
  highDensityThreshold: 5,
  focusBlockMinHours: 2,
  travelBufferMinutes: 30,
  prepLookaheadHours: 24,
  analysisWindowDays: 30,
};

// ── Initialization ───────────────────────────────────────────

export function initCalendarIntelConsumer(supabase: SupabaseClient): void {
  supabaseRef = supabase;

  // Load from DB on startup
  loadPreferences().catch(err => logger.error("Preferences load failed", err));

  subscribe("consumer:calendar-intel", { content_type: "event" }, async (message) => {
    try {
      await handleMessage(message);
    } catch (err) {
      logger.error("Calendar Intel consumer failed", { messageId: message.id, err });
    }
  });

  // Sync intel from calendar_events (forest DB) every 5 min
  syncFromCalendarEvents().catch(err => logger.error("Initial calendar intel sync failed", err));
  setInterval(() => {
    syncFromCalendarEvents().catch(err => logger.error("Calendar intel sync failed", err));
  }, 5 * 60_000);

  // Run pattern analysis nightly (check every hour)
  setInterval(() => {
    runPatternAnalysisIfNeeded().catch(err => logger.error("Pattern analysis failed", err));
  }, 60 * 60_000);

  // Auto-generate prep notes for upcoming meetings (every 15 min)
  generatePrepNotes().catch(err => logger.error("Initial prep generation failed", err));
  setInterval(() => {
    generatePrepNotes().catch(err => logger.error("Prep generation failed", err));
  }, 15 * 60_000);

  logger.info("Calendar Intel consumer initialized (ELLIE-319, DB-backed, Phase 2 prep)");
}

// ── Sync from Forest DB ──────────────────────────────────────

/**
 * Pull upcoming events from the Forest calendar_events table and
 * upsert into calendar_intel with conflict/prep analysis.
 */
async function syncFromCalendarEvents(): Promise<void> {
  if (!supabaseRef) return;

  let events: Array<Record<string, unknown>>;
  try {
    const { sql } = await import("../../../../ellie-forest/src/index.ts");
    const windowStart = new Date().toISOString();
    const windowEnd = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    events = await sql`
      SELECT external_id, provider, title, description, location,
             start_time, end_time, timezone, all_day, status,
             attendees, organizer, meeting_url
      FROM calendar_events
      WHERE end_time >= ${windowStart}
        AND start_time <= ${windowEnd}
        AND status != 'cancelled'
      ORDER BY start_time ASC
    `;
  } catch (err) {
    logger.error("Failed to fetch calendar events from Forest", err);
    return;
  }

  if (!events || events.length === 0) {
    logger.debug("No upcoming calendar events found");
    return;
  }

  const now = new Date().toISOString();

  // Upsert each event into calendar_intel
  // Fetch existing rows first so we don't overwrite user-edited prep status/notes
  const existingEventIds = new Set<string>();
  const { data: existingRows } = await supabaseRef
    .from("calendar_intel")
    .select("event_id, prep_status, prep_notes")
    .in("event_id", events.map(e => e.external_id as string));
  const existingMap = new Map<string, { prep_status: string; prep_notes: string | null }>();
  for (const row of existingRows || []) {
    existingMap.set(row.event_id, row);
    existingEventIds.add(row.event_id);
  }

  for (const ev of events) {
    const attendees = Array.isArray(ev.attendees) ? ev.attendees : [];
    const meetingType = classifyMeeting(ev.title as string, attendees.length, ev.all_day as boolean);
    const energyCost = estimateEnergyCost(meetingType, attendees.length);

    // Don't overwrite user-edited prep status (ready/reviewed)
    const existing = existingMap.get(ev.external_id as string);
    const userEdited = existing && (existing.prep_status === "ready" || existing.prep_status === "reviewed");
    const prepStatus = userEdited
      ? existing.prep_status
      : needsPrep(ev.title as string, attendees.length) ? "needed" : "not_needed";

    await supabaseRef.from("calendar_intel").upsert({
      event_id: ev.external_id,
      provider: ev.provider,
      title: ev.title,
      start_time: ev.start_time,
      end_time: ev.end_time,
      location: ev.location || null,
      attendees,
      organizer: ev.organizer || null,
      meeting_url: ev.meeting_url || null,
      all_day: ev.all_day || false,
      meeting_type: meetingType,
      energy_cost: energyCost,
      prep_status: prepStatus,
      last_synced: now,
      updated_at: now,
    }, { onConflict: "event_id" });
  }

  // Now run conflict detection across all upcoming events
  await detectConflicts();

  // Refresh the in-memory cache
  await refreshCache();

  // Rebuild insights
  rebuildInsights();

  logger.info("Calendar intel synced", { events: events.length, insights: insights.length });
}

// ── Cache Management ─────────────────────────────────────────

async function refreshCache(): Promise<void> {
  if (!supabaseRef) return;
  const windowStart = new Date().toISOString();
  const windowEnd = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabaseRef
    .from("calendar_intel")
    .select("*")
    .gte("start_time", windowStart)
    .lte("start_time", windowEnd)
    .order("start_time", { ascending: true })
    .limit(200);

  if (error) {
    logger.error("Failed to load calendar intel from DB", error);
    return;
  }

  intelCache.clear();
  for (const row of (data || []) as CalendarIntelRow[]) {
    intelCache.set(row.event_id, row);
  }
}

async function loadPreferences(): Promise<void> {
  if (!supabaseRef) return;
  try {
    const { data } = await supabaseRef
      .from("calendar_intel_preferences")
      .select("key, value");

    if (!data) return;
    for (const row of data) {
      const val = typeof row.value === "string" ? JSON.parse(row.value) : row.value;
      switch (row.key) {
        case "prep_keywords":
          if (Array.isArray(val)) prefs.prepKeywords = val;
          break;
        case "large_meeting_threshold":
          prefs.largeMeetingThreshold = Number(val) || 5;
          break;
        case "back_to_back_minutes":
          prefs.backToBackMinutes = Number(val) || 15;
          break;
        case "high_density_threshold":
          prefs.highDensityThreshold = Number(val) || 5;
          break;
        case "focus_block_min_hours":
          prefs.focusBlockMinHours = Number(val) || 2;
          break;
        case "travel_buffer_minutes":
          prefs.travelBufferMinutes = Number(val) || 30;
          break;
        case "prep_lookahead_hours":
          prefs.prepLookaheadHours = Number(val) || 24;
          break;
        case "analysis_window_days":
          prefs.analysisWindowDays = Number(val) || 30;
          break;
      }
    }
  } catch {
    // Use defaults
  }
}

// ── Message Handler (UMS events) ─────────────────────────────

async function handleMessage(message: UnifiedMessage): Promise<void> {
  if (message.provider !== "calendar") return;

  // Calendar events through UMS trigger an immediate re-sync
  // The sync pulls from Forest DB which has the full event data
  await syncFromCalendarEvents();
}

// ── Conflict Detection ───────────────────────────────────────

async function detectConflicts(): Promise<void> {
  if (!supabaseRef) return;

  const windowStart = new Date().toISOString();
  const windowEnd = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  const { data: events } = await supabaseRef
    .from("calendar_intel")
    .select("event_id, title, start_time, end_time, location, all_day")
    .gte("start_time", windowStart)
    .lte("start_time", windowEnd)
    .order("start_time", { ascending: true });

  if (!events || events.length < 2) return;

  const now = new Date().toISOString();
  const bufferMs = prefs.backToBackMinutes * 60 * 1000;

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (ev.all_day) continue;

    const evEnd = new Date(ev.end_time).getTime();
    const conflictWith: string[] = [];
    let isBackToBack = false;

    for (let j = 0; j < events.length; j++) {
      if (i === j) continue;
      const other = events[j];
      if (other.all_day) continue;

      const otherStart = new Date(other.start_time).getTime();
      const otherEnd = new Date(other.end_time).getTime();
      const evStart = new Date(ev.start_time).getTime();

      // Time overlap = conflict
      if (evStart < otherEnd && evEnd > otherStart) {
        conflictWith.push(other.event_id);
      }

      // Back-to-back: gap < buffer threshold
      const gap = otherStart - evEnd;
      if (gap >= 0 && gap < bufferMs) {
        isBackToBack = true;
      }
    }

    // Travel warning: different locations with < travel buffer between them
    let travelWarning = false;
    if (ev.location && i > 0) {
      const prev = events[i - 1];
      if (prev.location && prev.location !== ev.location && !prev.all_day) {
        const gap = new Date(ev.start_time).getTime() - new Date(prev.end_time).getTime();
        if (gap < prefs.travelBufferMinutes * 60 * 1000) {
          travelWarning = true;
        }
      }
    }

    await supabaseRef
      .from("calendar_intel")
      .update({
        has_conflict: conflictWith.length > 0,
        conflict_with: conflictWith,
        is_back_to_back: isBackToBack,
        travel_warning: travelWarning,
        updated_at: now,
      })
      .eq("event_id", ev.event_id);
  }
}

// ── Insight Generation ───────────────────────────────────────

function rebuildInsights(): void {
  insights.length = 0;

  const now = Date.now();
  const events = Array.from(intelCache.values());

  // Per-event insights
  for (const ev of events) {
    if (ev.has_conflict) {
      // Build conflict resolution suggestions
      const conflicting = ev.conflict_with
        .map(id => intelCache.get(id))
        .filter(Boolean) as CalendarIntelRow[];
      const suggestions = buildConflictSuggestions(ev, conflicting);

      insights.push({
        type: "conflict",
        severity: "alert",
        message: `Schedule conflict: "${ev.title}" overlaps with ${ev.conflict_with.length} other event(s)`,
        event_id: ev.event_id,
        metadata: { conflict_with: ev.conflict_with, suggestions },
      });
    }

    if (ev.prep_status === "needed") {
      const hoursUntil = (new Date(ev.start_time).getTime() - now) / (1000 * 60 * 60);
      if (hoursUntil <= prefs.prepLookaheadHours) {
        insights.push({
          type: "prep_needed",
          severity: hoursUntil < 2 ? "warning" : "info",
          message: `"${ev.title}" needs prep (in ${Math.round(hoursUntil)}h)`,
          event_id: ev.event_id,
          metadata: { hours_until: hoursUntil, meeting_type: ev.meeting_type },
        });
      }
    }

    if (ev.is_back_to_back) {
      insights.push({
        type: "back_to_back",
        severity: "info",
        message: `"${ev.title}" is back-to-back with previous event`,
        event_id: ev.event_id,
        metadata: {},
      });
    }

    if (ev.travel_warning) {
      insights.push({
        type: "back_to_back",
        severity: "warning",
        message: `Travel needed before "${ev.title}" — location change with tight gap`,
        event_id: ev.event_id,
        metadata: { location: ev.location },
      });
    }
  }

  // Daily aggregation: busy day detection
  const dayBuckets = new Map<string, CalendarIntelRow[]>();
  for (const ev of events) {
    if (ev.all_day) continue;
    const day = ev.start_time.split("T")[0];
    const bucket = dayBuckets.get(day) || [];
    bucket.push(ev);
    dayBuckets.set(day, bucket);
  }

  for (const [day, dayEvents] of dayBuckets) {
    if (dayEvents.length >= prefs.highDensityThreshold) {
      insights.push({
        type: "high_density",
        severity: "warning",
        message: `High-density day on ${day}: ${dayEvents.length} meetings`,
        event_id: null,
        metadata: { date: day, count: dayEvents.length },
      });
    }
  }

  // Focus block opportunities: gaps >= focusBlockMinHours between meetings today
  const todayStr = new Date().toISOString().split("T")[0];
  const todayEvents = (dayBuckets.get(todayStr) || [])
    .filter(e => !e.all_day)
    .sort((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime());

  for (let i = 0; i < todayEvents.length - 1; i++) {
    const gapStart = new Date(todayEvents[i].end_time!).getTime();
    const gapEnd = new Date(todayEvents[i + 1].start_time).getTime();
    const gapHours = (gapEnd - gapStart) / (1000 * 60 * 60);
    if (gapHours >= prefs.focusBlockMinHours) {
      const gapStartStr = new Date(gapStart).toLocaleTimeString("en-US", {
        hour: "numeric", minute: "2-digit", timeZone: "America/Chicago",
      });
      const gapEndStr = new Date(gapEnd).toLocaleTimeString("en-US", {
        hour: "numeric", minute: "2-digit", timeZone: "America/Chicago",
      });
      insights.push({
        type: "focus_opportunity",
        severity: "info",
        message: `Focus block available: ${gapStartStr}–${gapEndStr} (${Math.round(gapHours * 10) / 10}h)`,
        event_id: null,
        metadata: { gap_start: gapStart, gap_end: gapEnd, hours: gapHours },
      });
    }
  }
}

// ── Classification Helpers ───────────────────────────────────

function classifyMeeting(title: string, attendeeCount: number, allDay: boolean): string {
  if (allDay) return "personal";
  const lower = title.toLowerCase();

  if (/\b(standup|stand-up|scrum|daily)\b/.test(lower)) return "recurring_standup";
  if (/\b(1:1|one.on.one|1-on-1)\b/.test(lower)) return "one_on_one";
  if (/\b(focus|deep work|heads down|blocked)\b/.test(lower)) return "focus_block";
  if (/\b(lunch|dinner|gym|doctor|dentist|personal|errand)\b/.test(lower)) return "personal";

  if (attendeeCount >= prefs.largeMeetingThreshold) return "large_meeting";
  if (attendeeCount >= 3) return "small_group";
  if (attendeeCount === 2) return "one_on_one";

  return "unknown";
}

function estimateEnergyCost(meetingType: string, attendeeCount: number): string {
  switch (meetingType) {
    case "large_meeting": return "high";
    case "one_on_one": return "medium";
    case "recurring_standup": return "low";
    case "focus_block": return "low";
    case "personal": return "low";
    case "external": return "high";
    default: return attendeeCount >= prefs.largeMeetingThreshold ? "high" : "medium";
  }
}

function needsPrep(title: string, attendeeCount: number): boolean {
  const lower = title.toLowerCase();
  if (attendeeCount >= prefs.largeMeetingThreshold) return true;
  return prefs.prepKeywords.some(kw => lower.includes(kw.toLowerCase()));
}

// ── Pattern Analysis ─────────────────────────────────────────

/** Run pattern analysis once per day (checks if already run today). */
async function runPatternAnalysisIfNeeded(): Promise<void> {
  if (!supabaseRef) return;

  const today = new Date().toISOString().split("T")[0];
  const currentHour = new Date().getHours();

  // Only run at night (2-4 AM CST range)
  if (currentHour < 2 || currentHour > 4) return;

  // Check if already ran today
  const { count } = await supabaseRef
    .from("calendar_patterns")
    .select("*", { count: "exact", head: true })
    .eq("pattern_type", "weekly_summary")
    .eq("period_end", today);

  if ((count ?? 0) > 0) return;

  await runPatternAnalysis();
}

async function runPatternAnalysis(): Promise<void> {
  if (!supabaseRef) return;

  const today = new Date().toISOString().split("T")[0];
  const windowStart = new Date(Date.now() - prefs.analysisWindowDays * 24 * 60 * 60 * 1000).toISOString();

  let events: Array<Record<string, unknown>>;
  try {
    const { sql } = await import("../../../../ellie-forest/src/index.ts");
    events = await sql`
      SELECT title, start_time, end_time, all_day, attendees, location
      FROM calendar_events
      WHERE start_time >= ${windowStart}
        AND status != 'cancelled'
      ORDER BY start_time ASC
    `;
  } catch (err) {
    logger.error("Pattern analysis: failed to fetch events", err);
    return;
  }

  if (!events || events.length < 5) return;

  // Meeting density by day of week
  const dayBuckets: Record<number, number[]> = {};
  const hourBuckets: Record<number, number> = {};
  let totalMeetings = 0;
  let totalMeetingMinutes = 0;

  for (const ev of events) {
    if (ev.all_day) continue;
    const start = new Date(ev.start_time as string);
    const end = new Date(ev.end_time as string);
    const day = start.getDay();
    const hour = start.getHours();

    if (!dayBuckets[day]) dayBuckets[day] = [];
    dayBuckets[day].push(1);

    hourBuckets[hour] = (hourBuckets[hour] || 0) + 1;
    totalMeetings++;
    totalMeetingMinutes += (end.getTime() - start.getTime()) / 60000;
  }

  // Weekly summary
  const weeks = prefs.analysisWindowDays / 7;
  await supabaseRef.from("calendar_patterns").upsert({
    pattern_type: "weekly_summary",
    data: {
      total_meetings: totalMeetings,
      avg_meetings_per_week: Math.round(totalMeetings / weeks * 10) / 10,
      avg_meeting_minutes_per_day: Math.round(totalMeetingMinutes / prefs.analysisWindowDays),
      total_meeting_hours: Math.round(totalMeetingMinutes / 60),
    },
    sample_size: totalMeetings,
    confidence: Math.min(1, totalMeetings / 50),
    period_start: windowStart.split("T")[0],
    period_end: today,
    updated_at: new Date().toISOString(),
  }, { onConflict: "id" });

  // Meeting density per day of week
  for (const [day, counts] of Object.entries(dayBuckets)) {
    const avg = counts.length / weeks;
    await supabaseRef.from("calendar_patterns").upsert({
      pattern_type: "meeting_density",
      day_of_week: Number(day),
      data: {
        avg_meetings: Math.round(avg * 10) / 10,
        total_in_window: counts.length,
        busiest: avg >= prefs.highDensityThreshold,
      },
      sample_size: counts.length,
      confidence: Math.min(1, counts.length / 10),
      period_start: windowStart.split("T")[0],
      period_end: today,
      updated_at: new Date().toISOString(),
    }, { onConflict: "id" });
  }

  // Peak meeting hours
  const sortedHours = Object.entries(hourBuckets)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  for (const [hour, count] of sortedHours) {
    await supabaseRef.from("calendar_patterns").upsert({
      pattern_type: "focus_hours",
      hour_of_day: Number(hour),
      data: {
        meeting_count: count,
        is_busy: count > totalMeetings / 12,
        suggestion: count > totalMeetings / 12 ? "avoid_scheduling" : "good_for_focus",
      },
      sample_size: count,
      confidence: Math.min(1, count / 5),
      period_start: windowStart.split("T")[0],
      period_end: today,
      updated_at: new Date().toISOString(),
    }, { onConflict: "id" });
  }

  logger.info("Pattern analysis complete", { events: events.length, patterns: sortedHours.length + Object.keys(dayBuckets).length + 1 });
}

// ── Phase 2: Auto-Prep Note Generation ──────────────────────

const BRIDGE_KEY = "bk_d81869ef1556947b38376429ab2d9752ec0ed2799dc85d968532a6e740f6577a";

/**
 * Generate prep notes for upcoming events within the lookahead window
 * that need prep but don't have notes yet.
 */
async function generatePrepNotes(): Promise<void> {
  if (!supabaseRef) return;

  const cutoff = new Date(Date.now() + prefs.prepLookaheadHours * 60 * 60 * 1000).toISOString();
  const now = new Date().toISOString();

  // Find events that need prep but have no notes generated
  const { data: events } = await supabaseRef
    .from("calendar_intel")
    .select("*")
    .eq("prep_status", "needed")
    .is("prep_notes", null)
    .gte("start_time", now)
    .lte("start_time", cutoff)
    .order("start_time", { ascending: true })
    .limit(5);

  if (!events || events.length === 0) return;

  for (const ev of events as CalendarIntelRow[]) {
    try {
      const notes = await buildPrepNotes(ev);
      if (notes) {
        await supabaseRef
          .from("calendar_intel")
          .update({
            prep_notes: notes,
            prep_status: "ready",
            prep_generated_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq("event_id", ev.event_id);

        logger.info("Generated prep notes", { event: ev.title, event_id: ev.event_id });
      }
    } catch (err) {
      logger.error("Prep note generation failed", { event: ev.title, err });
    }
  }

  await refreshCache();
  rebuildInsights();
}

/**
 * Build prep notes for an event by pulling context from Forest, Comms, and UMS.
 */
async function buildPrepNotes(ev: CalendarIntelRow): Promise<string | null> {
  const sections: string[] = [];
  const attendeeNames = (ev.attendees || [])
    .map(a => a.name || a.email || "")
    .filter(Boolean);

  // ── 1. Meeting basics ──
  const startStr = new Date(ev.start_time).toLocaleString("en-US", {
    weekday: "short", hour: "numeric", minute: "2-digit", timeZone: "America/Chicago",
  });
  const basics: string[] = [`Type: ${ev.meeting_type.replace(/_/g, " ")}`, `When: ${startStr}`];
  if (ev.location) basics.push(`Where: ${ev.location}`);
  if (ev.meeting_url) basics.push(`Link: ${ev.meeting_url}`);
  if (attendeeNames.length > 0) basics.push(`With: ${attendeeNames.join(", ")}`);
  if (ev.energy_cost === "high") basics.push("Energy: high — consider pacing");
  sections.push(basics.join("\n"));

  // ── 2. Recent conversations with attendees (Comms) ──
  if (supabaseRef && attendeeNames.length > 0) {
    try {
      const commsContext = await fetchCommsContext(attendeeNames);
      if (commsContext) sections.push(commsContext);
    } catch {
      // Non-critical
    }
  }

  // ── 3. Recent messages from attendees (UMS) ──
  if (supabaseRef && attendeeNames.length > 0) {
    try {
      const messageContext = await fetchMessageContext(attendeeNames);
      if (messageContext) sections.push(messageContext);
    } catch {
      // Non-critical
    }
  }

  // ── 4. Relevant Forest findings ──
  try {
    const forestContext = await fetchForestContext(ev.title, attendeeNames);
    if (forestContext) sections.push(forestContext);
  } catch {
    // Non-critical
  }

  // ── 5. Conflict warnings ──
  if (ev.has_conflict && ev.conflict_with.length > 0) {
    const conflicting = ev.conflict_with
      .map(id => intelCache.get(id))
      .filter(Boolean) as CalendarIntelRow[];
    if (conflicting.length > 0) {
      const names = conflicting.map(c => `"${c.title}"`).join(", ");
      sections.push(`⚠️ Conflicts with: ${names}`);
    }
  }

  if (ev.is_back_to_back) {
    sections.push("⚠️ Back-to-back — no buffer before this meeting");
  }

  return sections.length > 1 ? sections.join("\n\n---\n\n") : null;
}

/** Fetch recent comms threads involving any of the attendee names. */
async function fetchCommsContext(attendeeNames: string[]): Promise<string | null> {
  if (!supabaseRef) return null;

  const lowerNames = attendeeNames.map(n => n.toLowerCase());

  // Search comms threads for participants matching attendee names
  const { data: threads } = await supabaseRef
    .from("comms_threads")
    .select("subject, last_sender, last_message_at, provider, message_count, participants")
    .eq("resolved", false)
    .order("last_message_at", { ascending: false })
    .limit(50);

  if (!threads || threads.length === 0) return null;

  const relevant = threads.filter(t => {
    const participants = Array.isArray(t.participants) ? t.participants : [];
    return participants.some((p: Record<string, string>) => {
      const name = (p.name || "").toLowerCase();
      const email = (p.email || "").toLowerCase();
      return lowerNames.some(n => name.includes(n) || email.includes(n));
    });
  });

  if (relevant.length === 0) return null;

  const lines = ["**Recent conversations:**"];
  for (const t of relevant.slice(0, 3)) {
    const ago = Math.round((Date.now() - new Date(t.last_message_at).getTime()) / (1000 * 60 * 60));
    const subject = t.subject ? t.subject.slice(0, 60) : "(no subject)";
    lines.push(`• ${subject} — ${t.last_sender || t.provider}, ${ago}h ago (${t.message_count} msgs)`);
  }
  return lines.join("\n");
}

/** Fetch recent messages from attendees via UMS. */
async function fetchMessageContext(attendeeNames: string[]): Promise<string | null> {
  if (!supabaseRef) return null;

  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data: messages } = await supabaseRef
    .from("unified_messages")
    .select("sender, content, provider, received_at")
    .gte("received_at", since)
    .not("sender", "is", null)
    .order("received_at", { ascending: false })
    .limit(200);

  if (!messages || messages.length === 0) return null;

  const lowerNames = attendeeNames.map(n => n.toLowerCase());
  const relevant = messages.filter(m => {
    const sender = m.sender as Record<string, string> | null;
    if (!sender) return false;
    const name = (sender.name || "").toLowerCase();
    const email = (sender.email || "").toLowerCase();
    return lowerNames.some(n => name.includes(n) || email.includes(n));
  });

  if (relevant.length === 0) return null;

  const lines = ["**Recent messages:**"];
  for (const m of relevant.slice(0, 3)) {
    const sender = m.sender as Record<string, string>;
    const who = sender.name || sender.email || "unknown";
    const preview = (m.content || "").slice(0, 80);
    const ago = Math.round((Date.now() - new Date(m.received_at).getTime()) / (1000 * 60 * 60));
    lines.push(`• ${who} (${m.provider}, ${ago}h ago): ${preview}`);
  }
  return lines.join("\n");
}

/** Search Forest for findings related to the meeting topic or attendees. */
async function fetchForestContext(title: string, attendeeNames: string[]): Promise<string | null> {
  const query = [title, ...attendeeNames.slice(0, 3)].join(" ");

  try {
    const resp = await fetch("http://localhost:3001/api/bridge/read", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-bridge-key": BRIDGE_KEY,
      },
      body: JSON.stringify({ query, scope_path: "2", limit: 3 }),
      signal: AbortSignal.timeout(5000),
    });

    if (!resp.ok) return null;

    const data = await resp.json() as {
      results?: Array<{ content: string; type: string; confidence: number }>;
    };

    if (!data.results || data.results.length === 0) return null;

    const lines = ["**Related context (Forest):**"];
    for (const finding of data.results) {
      const prefix = finding.type === "decision" ? "Decision" : "Finding";
      lines.push(`• ${prefix}: ${finding.content.slice(0, 120)}`);
    }
    return lines.join("\n");
  } catch {
    return null;
  }
}

// ── Phase 2: Conflict Resolution Suggestions ─────────────────

interface ConflictSuggestion {
  action: "decline" | "reschedule" | "shorten" | "add_buffer" | "make_optional";
  target_event: string;
  reason: string;
}

function buildConflictSuggestions(event: CalendarIntelRow, conflicting: CalendarIntelRow[]): ConflictSuggestion[] {
  const suggestions: ConflictSuggestion[] = [];

  for (const other of conflicting) {
    // Compare energy costs and meeting types to suggest which to move
    const evPriority = meetingPriority(event);
    const otherPriority = meetingPriority(other);

    if (evPriority > otherPriority) {
      // The current event is higher priority — suggest moving the other
      suggestions.push({
        action: "reschedule",
        target_event: other.event_id,
        reason: `"${other.title}" (${other.meeting_type.replace(/_/g, " ")}) is lower priority — consider rescheduling`,
      });
    } else if (otherPriority > evPriority) {
      suggestions.push({
        action: "reschedule",
        target_event: event.event_id,
        reason: `"${event.title}" is lower priority than "${other.title}" — consider rescheduling`,
      });
    } else {
      // Same priority — suggest shortening one
      suggestions.push({
        action: "shorten",
        target_event: other.event_id,
        reason: `Both similar priority — consider shortening "${other.title}" to avoid overlap`,
      });
    }

    // If one is a recurring standup, suggest making it optional
    if (other.meeting_type === "recurring_standup") {
      suggestions.push({
        action: "make_optional",
        target_event: other.event_id,
        reason: `"${other.title}" is a recurring standup — skip this occurrence`,
      });
    }
    if (event.meeting_type === "recurring_standup") {
      suggestions.push({
        action: "make_optional",
        target_event: event.event_id,
        reason: `"${event.title}" is a recurring standup — skip this occurrence`,
      });
    }
  }

  return suggestions;
}

/** Priority score for conflict resolution (higher = more important). */
function meetingPriority(ev: CalendarIntelRow): number {
  const typeScores: Record<string, number> = {
    external: 5,
    one_on_one: 4,
    large_meeting: 3,
    small_group: 3,
    recurring_standup: 1,
    focus_block: 2,
    personal: 1,
    unknown: 2,
  };
  let score = typeScores[ev.meeting_type] ?? 2;
  if (ev.energy_cost === "high") score += 1;
  if ((ev.attendees?.length || 0) >= prefs.largeMeetingThreshold) score += 1;
  return score;
}

/** Export: generate prep notes for a specific event on demand. */
export async function generatePrepForEvent(eventId: string): Promise<string | null> {
  if (!supabaseRef) return null;

  const { data: ev } = await supabaseRef
    .from("calendar_intel")
    .select("*")
    .eq("id", eventId)
    .single();

  if (!ev) return null;

  const notes = await buildPrepNotes(ev as CalendarIntelRow);
  if (notes) {
    await supabaseRef
      .from("calendar_intel")
      .update({
        prep_notes: notes,
        prep_status: "ready",
        prep_generated_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", eventId);

    await refreshCache();
    rebuildInsights();
  }

  return notes;
}

// ── Force Invalidation ───────────────────────────────────────

export async function invalidateCalendarIntelCache(): Promise<void> {
  await Promise.all([refreshCache(), loadPreferences()]);
  rebuildInsights();
}

export async function triggerSync(): Promise<void> {
  await syncFromCalendarEvents();
}

// ── Exports for Summary Bar, Briefing & API ──────────────────

/** Get all current calendar insights. */
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

/** Get upcoming events with intel (from cache). */
export function getUpcomingIntel(): CalendarIntelRow[] {
  return Array.from(intelCache.values());
}

/** Get events needing prep. */
export function getEventsNeedingPrep(): CalendarIntelRow[] {
  return Array.from(intelCache.values()).filter(
    e => e.prep_status === "needed" || e.prep_status === "ready"
  );
}

/** Get events with conflicts. */
export function getConflictingEvents(): CalendarIntelRow[] {
  return Array.from(intelCache.values()).filter(e => e.has_conflict);
}

/** Suggest focus blocks — gaps in today's schedule. */
export function suggestFocusBlocks(): Array<{ start: string; end: string; hours: number }> {
  const todayStr = new Date().toISOString().split("T")[0];
  const events = Array.from(intelCache.values())
    .filter(e => e.start_time.startsWith(todayStr) && !e.all_day)
    .sort((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime());

  const blocks: Array<{ start: string; end: string; hours: number }> = [];

  // Check gap from now to first meeting
  const now = Date.now();
  if (events.length > 0) {
    const firstStart = new Date(events[0].start_time).getTime();
    const gapHours = (firstStart - now) / (1000 * 60 * 60);
    if (gapHours >= prefs.focusBlockMinHours) {
      blocks.push({
        start: new Date(now).toISOString(),
        end: events[0].start_time,
        hours: Math.round(gapHours * 10) / 10,
      });
    }
  }

  // Check gaps between meetings
  for (let i = 0; i < events.length - 1; i++) {
    const gapStart = new Date(events[i].end_time!).getTime();
    const gapEnd = new Date(events[i + 1].start_time).getTime();
    const gapHours = (gapEnd - gapStart) / (1000 * 60 * 60);
    if (gapHours >= prefs.focusBlockMinHours) {
      blocks.push({
        start: new Date(gapStart).toISOString(),
        end: events[i + 1].start_time,
        hours: Math.round(gapHours * 10) / 10,
      });
    }
  }

  return blocks;
}
