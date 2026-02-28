/**
 * Comms API — Thread tracking, snooze/resolve, preferences
 *
 * ELLIE-318: Comms Assistant Module endpoints
 *
 * Endpoints:
 *   GET    /api/comms/threads          — list threads (filters: provider, status, priority)
 *   GET    /api/comms/threads/:id      — thread detail with messages
 *   GET    /api/comms/stale            — stale threads awaiting reply
 *   POST   /api/comms/threads/:id/snooze  — snooze a thread
 *   POST   /api/comms/threads/:id/resolve — resolve a thread
 *   GET    /api/comms/preferences      — get comms preferences
 *   PUT    /api/comms/preferences      — update comms preferences
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ApiRequest, ApiResponse } from "./types.ts";
import { getStaleThreads, invalidateCommsCache } from "../ums/consumers/comms.ts";
import { log } from "../logger.ts";

const logger = log.child("comms-api");

// ── Thread Listing ───────────────────────────────────────────

export async function listThreads(req: ApiRequest, res: ApiResponse, supabase: SupabaseClient): Promise<void> {
  const provider = req.query?.provider;
  const status = req.query?.status || "active"; // active, stale, snoozed, resolved, all
  const priority = req.query?.priority;
  const limit = Math.min(Number(req.query?.limit) || 50, 200);

  let query = supabase
    .from("comms_threads")
    .select("*")
    .order("last_message_at", { ascending: false })
    .limit(limit);

  if (provider) query = query.eq("provider", provider);
  if (priority) query = query.eq("priority", priority);

  switch (status) {
    case "active":
      query = query.eq("resolved", false);
      break;
    case "stale":
      query = query.eq("resolved", false).eq("awaiting_reply", true);
      break;
    case "snoozed":
      query = query.not("snoozed_until", "is", null);
      break;
    case "resolved":
      query = query.eq("resolved", true);
      break;
    // "all" — no filter
  }

  const { data, error } = await query;

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  res.json({ success: true, threads: data || [] });
}

// ── Thread Detail ────────────────────────────────────────────

export async function getThread(req: ApiRequest, res: ApiResponse, supabase: SupabaseClient): Promise<void> {
  const id = req.params?.id;
  if (!id) {
    res.status(400).json({ error: "Thread ID required" });
    return;
  }

  // Fetch thread
  const { data: thread, error } = await supabase
    .from("comms_threads")
    .select("*")
    .eq("id", id)
    .single();

  if (error || !thread) {
    res.status(404).json({ error: "Thread not found" });
    return;
  }

  // Fetch linked messages
  const { data: links } = await supabase
    .from("comms_thread_messages")
    .select("message_id")
    .eq("thread_id", id)
    .order("created_at", { ascending: false })
    .limit(50);

  let messages: unknown[] = [];
  if (links && links.length > 0) {
    const messageIds = links.map(l => l.message_id);
    const { data: msgs } = await supabase
      .from("unified_messages")
      .select("id, provider, sender, content, content_type, received_at")
      .in("id", messageIds)
      .order("received_at", { ascending: true });
    messages = msgs || [];
  }

  res.json({ success: true, thread, messages });
}

// ── Stale Threads ────────────────────────────────────────────

export async function getStale(_req: ApiRequest, res: ApiResponse, _supabase: SupabaseClient): Promise<void> {
  const stale = getStaleThreads();
  res.json({ success: true, threads: stale });
}

// ── Snooze ───────────────────────────────────────────────────

export async function snoozeThread(req: ApiRequest, res: ApiResponse, supabase: SupabaseClient): Promise<void> {
  const id = req.params?.id;
  if (!id) {
    res.status(400).json({ error: "Thread ID required" });
    return;
  }

  const { hours } = req.body || {};
  const snoozeHours = Number(hours) || 24;
  const snoozedUntil = new Date(Date.now() + snoozeHours * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from("comms_threads")
    .update({
      snoozed_until: snoozedUntil,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .select()
    .single();

  if (error || !data) {
    res.status(error ? 500 : 404).json({ error: error?.message || "Thread not found" });
    return;
  }

  await invalidateCommsCache();
  res.json({ success: true, thread: data, snoozed_until: snoozedUntil });
}

// ── Resolve ──────────────────────────────────────────────────

export async function resolveThread(req: ApiRequest, res: ApiResponse, supabase: SupabaseClient): Promise<void> {
  const id = req.params?.id;
  if (!id) {
    res.status(400).json({ error: "Thread ID required" });
    return;
  }

  const note = (req.body?.note as string) || null;
  const now = new Date().toISOString();

  const { data, error } = await supabase
    .from("comms_threads")
    .update({
      resolved: true,
      resolved_at: now,
      resolution_note: note,
      awaiting_reply: false,
      updated_at: now,
    })
    .eq("id", id)
    .select()
    .single();

  if (error || !data) {
    res.status(error ? 500 : 404).json({ error: error?.message || "Thread not found" });
    return;
  }

  await invalidateCommsCache();
  res.json({ success: true, thread: data });
}

// ── Preferences ──────────────────────────────────────────────

export async function getPreferences(_req: ApiRequest, res: ApiResponse, supabase: SupabaseClient): Promise<void> {
  const { data, error } = await supabase
    .from("comms_preferences")
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
      .from("comms_preferences")
      .upsert({
        key,
        value: typeof value === "string" ? value : JSON.stringify(value),
        updated_at: new Date().toISOString(),
      }, { onConflict: "key" });
  }

  // Reload preferences in consumer
  await invalidateCommsCache();

  res.json({ success: true });
}
