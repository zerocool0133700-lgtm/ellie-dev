/**
 * Calendar Intel API — Schedule intelligence, prep tracking, conflict detection, patterns
 *
 * ELLIE-319: Calendar Intel Module endpoints
 *
 * Endpoints:
 *   GET    /api/calendar-intel/upcoming         — upcoming events with intel
 *   GET    /api/calendar-intel/event/:id        — event detail with intel
 *   POST   /api/calendar-intel/event/:id/prep   — update prep status/notes
 *   POST   /api/calendar-intel/event/:id/mark-reviewed — mark event as reviewed
 *   GET    /api/calendar-intel/conflicts        — events with conflicts
 *   GET    /api/calendar-intel/patterns          — schedule patterns
 *   GET    /api/calendar-intel/suggest-focus-blocks — focus block suggestions
 *   GET    /api/calendar-intel/insights          — current insights
 *   POST   /api/calendar-intel/sync              — trigger manual sync
 *   POST   /api/calendar-intel/event/:id/generate-prep — auto-generate prep notes
 *   GET    /api/calendar-intel/preferences       — get preferences
 *   PUT    /api/calendar-intel/preferences       — update preferences
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ApiRequest, ApiResponse } from "./types.ts";
import {
  getCalendarInsights,
  getConflictingEvents,
  suggestFocusBlocks,
  invalidateCalendarIntelCache,
  triggerSync,
  generatePrepForEvent,
} from "../ums/consumers/calendar-intel.ts";

// ── Upcoming Events ──────────────────────────────────────────

export async function getUpcoming(req: ApiRequest, res: ApiResponse, supabase: SupabaseClient): Promise<void> {
  const days = Math.min(Number(req.query?.days) || 7, 30);
  const windowEnd = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from("calendar_intel")
    .select("*")
    .gte("start_time", new Date().toISOString())
    .lte("start_time", windowEnd)
    .order("start_time", { ascending: true })
    .limit(100);

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  res.json({ success: true, events: data || [] });
}

// ── Event Detail ─────────────────────────────────────────────

export async function getEvent(req: ApiRequest, res: ApiResponse, supabase: SupabaseClient): Promise<void> {
  const id = req.params?.id;
  if (!id) {
    res.status(400).json({ error: "Event ID required" });
    return;
  }

  const { data: event, error } = await supabase
    .from("calendar_intel")
    .select("*")
    .eq("id", id)
    .single();

  if (error || !event) {
    res.status(404).json({ error: "Event not found" });
    return;
  }

  // If there are conflicts, fetch the conflicting events for context
  let conflicts: unknown[] = [];
  if (event.has_conflict && event.conflict_with?.length > 0) {
    const { data: conflictEvents } = await supabase
      .from("calendar_intel")
      .select("id, event_id, title, start_time, end_time, location")
      .in("event_id", event.conflict_with);
    conflicts = conflictEvents || [];
  }

  res.json({ success: true, event, conflicts });
}

// ── Update Prep ──────────────────────────────────────────────

export async function updatePrep(req: ApiRequest, res: ApiResponse, supabase: SupabaseClient): Promise<void> {
  const id = req.params?.id;
  if (!id) {
    res.status(400).json({ error: "Event ID required" });
    return;
  }

  const { prep_status, prep_notes } = req.body || {};
  const updates: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };

  if (prep_status) {
    const valid = ["not_needed", "needed", "ready", "reviewed"];
    if (!valid.includes(prep_status as string)) {
      res.status(400).json({ error: `Invalid prep_status. Must be one of: ${valid.join(", ")}` });
      return;
    }
    updates.prep_status = prep_status;
  }
  if (prep_notes !== undefined) {
    updates.prep_notes = prep_notes;
    updates.prep_generated_at = new Date().toISOString();
  }

  const { data, error } = await supabase
    .from("calendar_intel")
    .update(updates)
    .eq("id", id)
    .select()
    .single();

  if (error || !data) {
    res.status(error ? 500 : 404).json({ error: error?.message || "Event not found" });
    return;
  }

  await invalidateCalendarIntelCache();
  res.json({ success: true, event: data });
}

// ── Mark Reviewed ────────────────────────────────────────────

export async function markReviewed(req: ApiRequest, res: ApiResponse, supabase: SupabaseClient): Promise<void> {
  const id = req.params?.id;
  if (!id) {
    res.status(400).json({ error: "Event ID required" });
    return;
  }

  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("calendar_intel")
    .update({
      reviewed: true,
      reviewed_at: now,
      updated_at: now,
    })
    .eq("id", id)
    .select()
    .single();

  if (error || !data) {
    res.status(error ? 500 : 404).json({ error: error?.message || "Event not found" });
    return;
  }

  await invalidateCalendarIntelCache();
  res.json({ success: true, event: data });
}

// ── Generate Prep (Phase 2) ──────────────────────────────────

export async function generatePrep(req: ApiRequest, res: ApiResponse, _supabase: SupabaseClient): Promise<void> {
  const id = req.params?.id;
  if (!id) {
    res.status(400).json({ error: "Event ID required" });
    return;
  }

  const notes = await generatePrepForEvent(id);
  if (!notes) {
    res.status(404).json({ error: "Event not found or no context available" });
    return;
  }

  res.json({ success: true, prep_notes: notes });
}

// ── Conflicts ────────────────────────────────────────────────

export async function getConflicts(_req: ApiRequest, res: ApiResponse, _supabase: SupabaseClient): Promise<void> {
  const conflicts = getConflictingEvents();
  res.json({ success: true, events: conflicts });
}

// ── Patterns ─────────────────────────────────────────────────

export async function getPatterns(req: ApiRequest, res: ApiResponse, supabase: SupabaseClient): Promise<void> {
  const patternType = req.query?.type;

  let query = supabase
    .from("calendar_patterns")
    .select("*")
    .order("updated_at", { ascending: false })
    .limit(50);

  if (patternType) query = query.eq("pattern_type", patternType);

  const { data, error } = await query;

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  res.json({ success: true, patterns: data || [] });
}

// ── Focus Block Suggestions ──────────────────────────────────

export function getFocusBlocks(_req: ApiRequest, res: ApiResponse): void {
  const blocks = suggestFocusBlocks();
  res.json({ success: true, blocks });
}

// ── Insights ─────────────────────────────────────────────────

export function getInsights(_req: ApiRequest, res: ApiResponse): void {
  const insights = getCalendarInsights();
  res.json({ success: true, insights });
}

// ── Manual Sync ──────────────────────────────────────────────

export async function syncCalendarIntel(_req: ApiRequest, res: ApiResponse): Promise<void> {
  await triggerSync();
  res.json({ success: true, message: "Calendar intel sync triggered" });
}

// ── Preferences ──────────────────────────────────────────────

export async function getPreferences(_req: ApiRequest, res: ApiResponse, supabase: SupabaseClient): Promise<void> {
  const { data, error } = await supabase
    .from("calendar_intel_preferences")
    .select("key, value");

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  const prefs: Record<string, unknown> = {};
  for (const row of data || []) {
    prefs[row.key] = row.value;
  }
  res.json({ success: true, preferences: prefs });
}

export async function updatePreferences(req: ApiRequest, res: ApiResponse, supabase: SupabaseClient): Promise<void> {
  const body = req.body || {};
  const entries = Object.entries(body);

  if (entries.length === 0) {
    res.status(400).json({ error: "No preferences to update" });
    return;
  }

  for (const [key, value] of entries) {
    await supabase
      .from("calendar_intel_preferences")
      .upsert({
        key,
        value: typeof value === "string" ? value : JSON.stringify(value),
        updated_at: new Date().toISOString(),
      }, { onConflict: "key" });
  }

  await invalidateCalendarIntelCache();
  res.json({ success: true });
}
