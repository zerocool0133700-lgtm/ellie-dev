/**
 * UMS Consumer: Comms Assistant
 *
 * ELLIE-308: Push subscriber — tracks conversation thread state
 * ELLIE-318: DB persistence, priority scoring, snooze/resolve, configurable thresholds
 *
 * Listens to: text messages from conversational channels
 * Action: maintains DB-backed thread tracking, flags stale unanswered threads
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { UnifiedMessage } from "../types.ts";
import { subscribe } from "../events.ts";
import { log } from "../../logger.ts";

const logger = log.child("ums-consumer-comms");

/** Channels where thread tracking makes sense. */
const THREADED_PROVIDERS = new Set(["telegram", "gchat", "gmail"]);

// ── Types ────────────────────────────────────────────────────

export interface ThreadState {
  id: string;
  thread_id: string;
  provider: string;
  channel: string | null;
  subject: string | null;
  participants: Array<{ name?: string; email?: string; username?: string }>;
  last_message_at: string;
  last_sender: string | null;
  message_count: number;
  awaiting_reply: boolean;
  priority: "critical" | "high" | "normal" | "low";
  snoozed_until: string | null;
  resolved: boolean;
  resolved_at: string | null;
  resolution_note: string | null;
  first_seen: string;
  updated_at: string;
}

// ── State ────────────────────────────────────────────────────

let supabaseRef: SupabaseClient | null = null;

/** In-memory cache for fast reads — synced from DB. */
const threadCache = new Map<string, ThreadState>();

/** Stale thresholds per provider (hours). */
let staleThresholds: Record<string, number> = {
  telegram: 4,
  gchat: 4,
  gmail: 48,
};

/** Owner identities — emails, usernames, names that identify the user's own messages. */
let ownerIdentities: string[] = [];

// ── Initialization ───────────────────────────────────────────

export function initCommsConsumer(supabase: SupabaseClient): void {
  supabaseRef = supabase;

  // Load from DB on startup
  refreshCache().catch(err => logger.error("Initial cache load failed", err));
  loadPreferences().catch(err => logger.error("Preferences load failed", err));
  loadOwnerIdentities().catch(err => logger.error("Owner identities load failed", err));

  subscribe("consumer:comms", {}, async (message) => {
    try {
      await handleMessage(message);
    } catch (err) {
      logger.error("Comms consumer failed", { messageId: message.id, err });
    }
  });

  // Periodic cache refresh
  setInterval(() => {
    refreshCache().catch(err => logger.error("Cache refresh failed", err));
  }, 60_000);

  // Unsnooze expired threads (every 5 min)
  setInterval(() => {
    unsnoozeExpired().catch(err => logger.error("Unsnooze failed", err));
  }, 5 * 60_000);

  // GTD auto-create for very stale threads (every 30 min)
  setInterval(() => {
    createGtdItemsForStaleThreads().catch(err => logger.error("GTD auto-create failed", err));
  }, 30 * 60_000);

  logger.info("Comms consumer initialized (ELLIE-318, DB-backed)");
}

// ── Cache Management ─────────────────────────────────────────

async function refreshCache(): Promise<void> {
  if (!supabaseRef) return;
  const { data, error } = await supabaseRef
    .from("comms_threads")
    .select("*")
    .eq("resolved", false)
    .order("last_message_at", { ascending: false })
    .limit(200);

  if (error) {
    logger.error("Failed to load threads from DB", error);
    return;
  }

  threadCache.clear();
  for (const row of (data || []) as ThreadState[]) {
    threadCache.set(row.thread_id, row);
  }
}

async function loadPreferences(): Promise<void> {
  if (!supabaseRef) return;
  try {
    const { data } = await supabaseRef
      .from("comms_preferences")
      .select("key, value")
      .eq("key", "stale_thresholds")
      .single();

    if (data?.value) {
      const val = typeof data.value === "string" ? JSON.parse(data.value) : data.value;
      staleThresholds = { ...staleThresholds, ...val };
    }
  } catch {
    // Use defaults
  }
}

async function loadOwnerIdentities(): Promise<void> {
  if (!supabaseRef) return;
  try {
    const { data } = await supabaseRef
      .from("comms_preferences")
      .select("value")
      .eq("key", "owner_identities")
      .single();

    if (data?.value) {
      const val = typeof data.value === "string" ? JSON.parse(data.value) : data.value;
      if (Array.isArray(val)) {
        ownerIdentities = val.map((v: string) => v.toLowerCase());
        logger.info("Loaded owner identities", { count: ownerIdentities.length });
      }
    }
  } catch {
    // No identities configured — isDave falls back to empty list
  }
}

async function unsnoozeExpired(): Promise<void> {
  if (!supabaseRef) return;
  const now = new Date().toISOString();
  const { data } = await supabaseRef
    .from("comms_threads")
    .update({ snoozed_until: null, updated_at: now })
    .lt("snoozed_until", now)
    .not("snoozed_until", "is", null)
    .select("thread_id");

  if (data && data.length > 0) {
    logger.info("Unsnoozed expired threads", { count: data.length });
    await refreshCache();
  }
}

/**
 * ELLIE-318 Phase 2: Auto-create GTD inbox items for threads past the GTD threshold.
 * Only creates if auto_gtd_create preference is enabled.
 */
async function createGtdItemsForStaleThreads(): Promise<void> {
  if (!supabaseRef) return;

  // Check if feature is enabled
  try {
    const { data: pref } = await supabaseRef
      .from("comms_preferences")
      .select("value")
      .eq("key", "auto_gtd_create")
      .single();

    const enabled = pref?.value === true || pref?.value === "true";
    if (!enabled) return;
  } catch {
    return;
  }

  // Get GTD threshold
  let thresholdHours = 72;
  try {
    const { data: pref } = await supabaseRef
      .from("comms_preferences")
      .select("value")
      .eq("key", "gtd_threshold_hours")
      .single();
    if (pref?.value) thresholdHours = Number(pref.value) || 72;
  } catch { /* use default */ }

  const cutoff = new Date(Date.now() - thresholdHours * 60 * 60 * 1000).toISOString();

  // Find stale threads past GTD threshold that haven't been resolved or snoozed
  const { data: threads } = await supabaseRef
    .from("comms_threads")
    .select("thread_id, provider, last_sender, subject")
    .eq("awaiting_reply", true)
    .eq("resolved", false)
    .is("snoozed_until", null)
    .lt("last_message_at", cutoff)
    .limit(10);

  if (!threads || threads.length === 0) return;

  for (const t of threads) {
    const who = t.last_sender || t.provider;
    const content = `Reply to ${who}${t.subject ? ` re: ${t.subject.slice(0, 50)}` : ""} (${t.provider})`;

    // Check if we already created a todo for this thread
    const { count } = await supabaseRef
      .from("todos")
      .select("*", { count: "exact", head: true })
      .eq("source_type", "comms")
      .eq("source_ref", t.thread_id)
      .in("status", ["inbox", "open"]);

    if ((count ?? 0) > 0) continue; // Already exists

    await supabaseRef.from("todos").insert({
      content,
      status: "inbox",
      tags: ["@comms"],
      source_type: "comms",
      source_ref: t.thread_id,
    });

    logger.info("Created GTD item for stale thread", { thread: t.thread_id, who });
  }
}

/** Force cache invalidation (after API writes). */
export async function invalidateCommsCache(): Promise<void> {
  await Promise.all([refreshCache(), loadOwnerIdentities()]);
}

// ── Message Handler ──────────────────────────────────────────

async function handleMessage(message: UnifiedMessage): Promise<void> {
  if (!THREADED_PROVIDERS.has(message.provider)) return;
  if (message.content_type !== "text" && message.content_type !== "voice") return;
  if (!supabaseRef) return;

  const threadId = resolveThreadId(message);
  const senderName = message.sender?.name || message.sender?.username || message.sender?.email || null;
  const now = new Date().toISOString();
  const isUser = isOwner(message);

  const existing = threadCache.get(threadId);

  if (existing) {
    const updates: Record<string, unknown> = {
      last_message_at: now,
      last_sender: senderName,
      message_count: existing.message_count + 1,
      awaiting_reply: !isUser,
      updated_at: now,
    };

    // Add participant if new
    if (message.sender && !isUser) {
      const participants = [...(existing.participants || [])];
      const alreadyKnown = participants.some(p =>
        (p.email && p.email === message.sender?.email) ||
        (p.username && p.username === message.sender?.username)
      );
      if (!alreadyKnown && (message.sender.email || message.sender.username || message.sender.name)) {
        participants.push({
          name: message.sender.name || undefined,
          email: message.sender.email || undefined,
          username: message.sender.username || undefined,
        });
        updates.participants = participants;
      }
    }

    // Un-snooze if someone replied
    if (!isUser && existing.snoozed_until) {
      updates.snoozed_until = null;
    }

    await supabaseRef
      .from("comms_threads")
      .update(updates)
      .eq("thread_id", threadId);

    // Update cache
    Object.assign(existing, updates);
  } else {
    // Create new thread
    const subject = message.content?.slice(0, 100) || null;
    const participants: Array<{ name?: string; email?: string; username?: string }> = [];
    if (message.sender && !isUser) {
      participants.push({
        name: message.sender.name || undefined,
        email: message.sender.email || undefined,
        username: message.sender.username || undefined,
      });
    }

    const newThread = {
      thread_id: threadId,
      provider: message.provider,
      channel: message.channel,
      subject,
      participants,
      last_message_at: now,
      last_sender: senderName,
      message_count: 1,
      awaiting_reply: !isUser,
      priority: "normal",
      first_seen: now,
      updated_at: now,
    };

    const { data: inserted } = await supabaseRef
      .from("comms_threads")
      .upsert(newThread, { onConflict: "thread_id" })
      .select()
      .single();

    if (inserted) {
      threadCache.set(threadId, inserted as ThreadState);
    }
  }

  // Link message to thread for drill-down
  const thread = threadCache.get(threadId);
  if (thread?.id && message.id) {
    supabaseRef
      .from("comms_thread_messages")
      .upsert({ thread_id: thread.id, message_id: message.id }, { onConflict: "thread_id,message_id" })
      .then(() => {})
      .catch(() => {}); // non-critical, fire-and-forget
  }
}

// ── Helpers ──────────────────────────────────────────────────

function resolveThreadId(message: UnifiedMessage): string {
  const meta = message.metadata || {};
  if (meta.thread_name) return `${message.provider}:${meta.thread_name}`;
  if (meta.thread_id) return `${message.provider}:${meta.thread_id}`;
  if (meta.conversation_id) return `${message.provider}:${meta.conversation_id}`;
  return message.channel || `${message.provider}:${message.provider_id}`;
}

/** Check if a message was sent by the owner (Dave) using configured identities. */
function isOwner(message: UnifiedMessage): boolean {
  const s = message.sender;
  if (!s) return false;
  if (ownerIdentities.length === 0) return false;

  const email = (s.email || "").toLowerCase();
  const username = (s.username || "").toLowerCase();
  const name = (s.name || "").toLowerCase();

  return ownerIdentities.some(id =>
    (email && email === id) ||
    (username && username === id) ||
    (name && name === id)
  );
}

// ── Exports for Summary Bar & API ────────────────────────────

/**
 * Get threads that are awaiting a reply and stale per provider threshold.
 * Excludes snoozed and resolved threads.
 */
export function getStaleThreads(): ThreadState[] {
  const now = Date.now();
  const stale: ThreadState[] = [];

  for (const thread of threadCache.values()) {
    if (!thread.awaiting_reply) continue;
    if (thread.resolved) continue;
    if (thread.snoozed_until && new Date(thread.snoozed_until).getTime() > now) continue;

    const thresholdHours = staleThresholds[thread.provider] ?? 4;
    const thresholdMs = thresholdHours * 60 * 60 * 1000;
    const lastAt = new Date(thread.last_message_at).getTime();

    if (now - lastAt > thresholdMs) {
      stale.push(thread);
    }
  }

  return stale.sort((a, b) =>
    new Date(a.last_message_at).getTime() - new Date(b.last_message_at).getTime()
  );
}

/** Get all active (non-resolved) thread states. */
export function getActiveThreads(): ThreadState[] {
  return Array.from(threadCache.values()).filter(t => !t.resolved);
}

/** Get stale thresholds (for API). */
export function getStaleThresholds(): Record<string, number> {
  return { ...staleThresholds };
}
