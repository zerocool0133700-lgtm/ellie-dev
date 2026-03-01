/**
 * Relationship Tracker API — Contact profiles, timeline, follow-ups, health
 *
 * ELLIE-320: Relationship Tracker endpoints
 *
 * Endpoints:
 *   GET    /api/relationships/profiles          — list profiles (with filters)
 *   GET    /api/relationships/profile/:id       — single profile detail
 *   PUT    /api/relationships/profile/:id       — update profile (importance, tags, notes, suppress)
 *   GET    /api/relationships/profile/:id/timeline — interaction timeline
 *   GET    /api/relationships/follow-ups        — profiles needing follow-up
 *   POST   /api/relationships/profile/:id/dismiss-follow-up — dismiss follow-up
 *   GET    /api/relationships/health            — health breakdown summary
 *   GET    /api/relationships/search            — search profiles by name/email/tag
 *   GET    /api/relationships/preferences       — get preferences
 *   PUT    /api/relationships/preferences       — update preferences
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ApiRequest, ApiResponse } from "./types.ts";
import { invalidateRelationshipCache } from "../ums/consumers/relationship.ts";

// ── List Profiles ─────────────────────────────────────────────

export async function listProfiles(req: ApiRequest, res: ApiResponse, supabase: SupabaseClient): Promise<void> {
  const limit = Math.min(Number(req.query?.limit) || 50, 200);
  const offset = Number(req.query?.offset) || 0;
  const status = req.query?.status;       // health_status filter
  const sortBy = req.query?.sort || "last_interaction_at";
  const order = req.query?.order === "asc" ? true : false;
  const showSuppressed = req.query?.suppressed === "true";

  let query = supabase
    .from("relationship_profiles")
    .select("*", { count: "exact" });

  if (!showSuppressed) query = query.eq("suppressed", false);
  if (status) query = query.eq("health_status", status);

  const validSorts = ["last_interaction_at", "health_score", "message_count", "importance", "created_at"];
  const sortCol = validSorts.includes(sortBy) ? sortBy : "last_interaction_at";

  query = query
    .order(sortCol, { ascending: order, nullsFirst: false })
    .range(offset, offset + limit - 1);

  const { data, error, count } = await query;

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  res.json({ success: true, profiles: data || [], total: count ?? 0, limit, offset });
}

// ── Get Profile ───────────────────────────────────────────────

export async function getProfile(req: ApiRequest, res: ApiResponse, supabase: SupabaseClient): Promise<void> {
  const id = req.params?.id;
  if (!id) {
    res.status(400).json({ error: "Profile ID required" });
    return;
  }

  const { data: profile, error } = await supabase
    .from("relationship_profiles")
    .select("*")
    .eq("id", id)
    .single();

  if (error || !profile) {
    res.status(404).json({ error: "Profile not found" });
    return;
  }

  // Get recent interaction count (last 30 days)
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { count: recentCount } = await supabase
    .from("interaction_log")
    .select("*", { count: "exact", head: true })
    .eq("profile_id", id)
    .gte("interaction_at", since);

  res.json({ success: true, profile, recent_interactions: recentCount ?? 0 });
}

// ── Update Profile ────────────────────────────────────────────

export async function updateProfile(req: ApiRequest, res: ApiResponse, supabase: SupabaseClient): Promise<void> {
  const id = req.params?.id;
  if (!id) {
    res.status(400).json({ error: "Profile ID required" });
    return;
  }

  const { importance, tags, notes, suppressed, display_name } = req.body || {};
  const updates: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };

  if (importance !== undefined) {
    const imp = Number(importance);
    if (isNaN(imp) || imp < 1 || imp > 5) {
      res.status(400).json({ error: "importance must be 1-5" });
      return;
    }
    updates.importance = imp;
  }
  if (tags !== undefined) {
    if (!Array.isArray(tags)) {
      res.status(400).json({ error: "tags must be an array" });
      return;
    }
    updates.tags = tags;
  }
  if (notes !== undefined) updates.notes = notes;
  if (suppressed !== undefined) updates.suppressed = Boolean(suppressed);
  if (display_name !== undefined) updates.display_name = display_name;

  const { data, error } = await supabase
    .from("relationship_profiles")
    .update(updates)
    .eq("id", id)
    .select()
    .single();

  if (error || !data) {
    res.status(error ? 500 : 404).json({ error: error?.message || "Profile not found" });
    return;
  }

  await invalidateRelationshipCache();
  res.json({ success: true, profile: data });
}

// ── Interaction Timeline ──────────────────────────────────────

export async function getTimeline(req: ApiRequest, res: ApiResponse, supabase: SupabaseClient): Promise<void> {
  const id = req.params?.id;
  if (!id) {
    res.status(400).json({ error: "Profile ID required" });
    return;
  }

  const limit = Math.min(Number(req.query?.limit) || 50, 200);
  const offset = Number(req.query?.offset) || 0;

  const { data, error, count } = await supabase
    .from("interaction_log")
    .select("*", { count: "exact" })
    .eq("profile_id", id)
    .order("interaction_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  res.json({ success: true, interactions: data || [], total: count ?? 0, limit, offset });
}

// ── Follow-ups ────────────────────────────────────────────────

export async function getFollowUps(_req: ApiRequest, res: ApiResponse, supabase: SupabaseClient): Promise<void> {
  const { data, error } = await supabase
    .from("relationship_profiles")
    .select("*")
    .eq("needs_follow_up", true)
    .eq("suppressed", false)
    .order("importance", { ascending: false })
    .order("follow_up_since", { ascending: true });

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  res.json({ success: true, profiles: data || [] });
}

// ── Dismiss Follow-up ─────────────────────────────────────────

export async function dismissFollowUp(req: ApiRequest, res: ApiResponse, supabase: SupabaseClient): Promise<void> {
  const id = req.params?.id;
  if (!id) {
    res.status(400).json({ error: "Profile ID required" });
    return;
  }

  const { data, error } = await supabase
    .from("relationship_profiles")
    .update({
      needs_follow_up: false,
      follow_up_reason: null,
      follow_up_since: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .select()
    .single();

  if (error || !data) {
    res.status(error ? 500 : 404).json({ error: error?.message || "Profile not found" });
    return;
  }

  await invalidateRelationshipCache();
  res.json({ success: true, profile: data });
}

// ── Health Breakdown ──────────────────────────────────────────

export async function getHealthBreakdown(_req: ApiRequest, res: ApiResponse, supabase: SupabaseClient): Promise<void> {
  // Count by health_status
  const { data, error } = await supabase
    .from("relationship_profiles")
    .select("health_status")
    .eq("suppressed", false);

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  const breakdown: Record<string, number> = {};
  for (const row of data || []) {
    const s = row.health_status || "new";
    breakdown[s] = (breakdown[s] || 0) + 1;
  }

  const total = (data || []).length;
  const followUp = await supabase
    .from("relationship_profiles")
    .select("*", { count: "exact", head: true })
    .eq("needs_follow_up", true)
    .eq("suppressed", false);

  res.json({
    success: true,
    breakdown,
    total,
    needs_follow_up: followUp.count ?? 0,
  });
}

// ── Search ────────────────────────────────────────────────────

export async function searchProfiles(req: ApiRequest, res: ApiResponse, supabase: SupabaseClient): Promise<void> {
  const q = req.query?.q;
  if (!q || q.length < 2) {
    res.status(400).json({ error: "Query 'q' must be at least 2 characters" });
    return;
  }

  const pattern = `%${q}%`;

  // Search across identifier, display_name, emails, usernames, names, tags
  const { data, error } = await supabase
    .from("relationship_profiles")
    .select("*")
    .or(`identifier.ilike.${pattern},display_name.ilike.${pattern}`)
    .eq("suppressed", false)
    .order("health_score", { ascending: false })
    .limit(30);

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  res.json({ success: true, profiles: data || [] });
}

// ── Preferences ───────────────────────────────────────────────

export async function getPreferences(_req: ApiRequest, res: ApiResponse, supabase: SupabaseClient): Promise<void> {
  const { data, error } = await supabase
    .from("relationship_preferences")
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
      .from("relationship_preferences")
      .upsert({
        key,
        value: typeof value === "string" ? value : JSON.stringify(value),
        updated_at: new Date().toISOString(),
      }, { onConflict: "key" });
  }

  await invalidateRelationshipCache();
  res.json({ success: true });
}
