/**
 * Thread Context — ELLIE-1374
 *
 * Thread lookup, participant filtering, and cross-thread awareness.
 * Used by the ellie-chat-handler to resolve thread config and by
 * the coordinator to filter the agent roster.
 */

import { log } from "./logger.ts";
import type { SupabaseClient } from "@supabase/supabase-js";

const logger = log.child("thread-context");

// ── Types ──────────────────────────────────────────────────

export interface ChatThread {
  id: string;
  channel_id: string;
  name: string;
  routing_mode: "coordinated" | "direct";
  direct_agent: string | null;
  created_by: string | null;
  created_at: string;
}

// ── Lookup ─────────────────────────────────────────────────

/** Get a thread by ID. Returns null if not found. */
export async function getThread(supabase: SupabaseClient, threadId: string): Promise<ChatThread | null> {
  const { data, error } = await supabase
    .from("chat_threads")
    .select("*")
    .eq("id", threadId)
    .single();

  if (error || !data) return null;
  return data as ChatThread;
}

/** Get the default "General" thread for ellie-chat. */
export async function getDefaultThread(supabase: SupabaseClient): Promise<ChatThread | null> {
  const { data, error } = await supabase
    .from("chat_threads")
    .select("*")
    .eq("name", "General")
    .eq("routing_mode", "coordinated")
    .order("created_at", { ascending: true })
    .limit(1)
    .single();

  if (error || !data) return null;
  return data as ChatThread;
}

/** Get participant agent names for a thread. */
export async function getThreadParticipants(supabase: SupabaseClient, threadId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from("thread_participants")
    .select("agent")
    .eq("thread_id", threadId);

  if (error || !data) return [];
  return data.map((r: { agent: string }) => r.agent);
}

// ── Roster Filtering ───────────────────────────────────────

/**
 * Filter the full agent roster to only include thread participants.
 * If threadAgents is null, returns the full roster (no filtering).
 */
export function filterRosterByThread(fullRoster: string[], threadAgents: string[] | null): string[] {
  if (!threadAgents) return fullRoster;
  const threadSet = new Set(threadAgents);
  return fullRoster.filter(a => threadSet.has(a));
}

// ── Cross-Thread Awareness ─────────────────────────────────

export interface SiblingThreadRecord {
  thread_id: string;
  thread_name: string;
  context_anchors: string | null;
}

/**
 * Build a cross-thread awareness signal for an agent.
 * Injects sibling thread context_anchors so the agent knows
 * it's active elsewhere and doesn't contradict itself.
 *
 * Returns null if no sibling threads have relevant context.
 */
export function buildCrossThreadAwareness(
  agent: string,
  currentThreadId: string,
  siblingRecords: SiblingThreadRecord[],
): string | null {
  const relevant = siblingRecords.filter(
    r => r.thread_id !== currentThreadId && r.context_anchors
  );

  if (relevant.length === 0) return null;

  const lines = relevant.map(r =>
    `- Thread "${r.thread_name}": ${r.context_anchors!.slice(0, 300)}`
  );

  return `## Cross-Thread Awareness
You are also active in other threads. Be consistent with your work there:
${lines.join("\n")}`;
}
