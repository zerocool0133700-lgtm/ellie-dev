/**
 * Thread API — ELLIE-1374
 *
 * GET    /api/threads              — list all threads with agent counts
 * POST   /api/threads              — create thread + participants
 * GET    /api/threads/:id          — single thread with participants
 * POST   /api/threads/:id/participants  — add participant
 * DELETE /api/threads/:id/participants/:agent — remove participant
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { log } from "../logger.ts";
import { broadcastToEllieChatClients } from "../relay-state.ts";

const logger = log.child("threads-api");

export interface Thread {
  id: string;
  name: string;
  channel_id: string;
  routing_mode: string;
  direct_agent: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  agent_count?: number;
}

export interface ThreadParticipant {
  thread_id: string;
  agent: string;
  joined_at: string;
}

/**
 * List all threads with agent counts.
 */
export async function listThreads(supabase: SupabaseClient): Promise<{ threads: Thread[] }> {
  const { data: threads, error } = await supabase
    .from("chat_threads")
    .select("*")
    .order("created_at", { ascending: true });

  if (error) throw error;

  const { data: participants } = await supabase
    .from("thread_participants")
    .select("thread_id");

  const countMap: Record<string, number> = {};
  for (const p of participants ?? []) {
    countMap[p.thread_id] = (countMap[p.thread_id] || 0) + 1;
  }

  const result: Thread[] = (threads ?? []).map(t => ({
    ...t,
    agent_count: countMap[t.id] || 0,
  }));

  return { threads: result };
}

/**
 * Create a new thread and seed its participants.
 */
export async function createThread(
  supabase: SupabaseClient,
  opts: {
    name: string;
    channel_id: string;
    routing_mode: string;
    direct_agent?: string;
    agents: string[];
    created_by?: string;
  },
): Promise<{ thread: { id: string; name: string } }> {
  const { name, channel_id, routing_mode, direct_agent, agents, created_by } = opts;

  const { data: thread, error } = await supabase
    .from("chat_threads")
    .insert({
      name,
      channel_id,
      routing_mode,
      direct_agent: direct_agent ?? null,
      created_by: created_by ?? null,
    })
    .select()
    .single();

  if (error) throw error;

  if (agents.length > 0) {
    const rows = agents.map(agent => ({ thread_id: thread.id, agent }));
    const { error: partErr } = await supabase.from("thread_participants").insert(rows);
    if (partErr) throw partErr;
  }

  logger.info("Thread created", { id: thread.id, name, routing_mode });

  broadcastToEllieChatClients({
    type: "thread_created",
    thread: { id: thread.id, name, channel_id, routing_mode },
  });

  return { thread: { id: thread.id, name: thread.name } };
}

/**
 * Fetch a single thread with its participant agent names.
 */
export async function getThreadWithParticipants(
  supabase: SupabaseClient,
  threadId: string,
): Promise<{ thread: Thread; participants: ThreadParticipant[] } | null> {
  const { data: thread, error } = await supabase
    .from("chat_threads")
    .select("*")
    .eq("id", threadId)
    .single();

  if (error || !thread) return null;

  const { data: participants } = await supabase
    .from("thread_participants")
    .select("*")
    .eq("thread_id", threadId)
    .order("joined_at", { ascending: true });

  return { thread, participants: participants ?? [] };
}

/**
 * Add an agent to a thread's participants (upsert — safe to call repeatedly).
 */
export async function addParticipant(
  supabase: SupabaseClient,
  threadId: string,
  agent: string,
): Promise<void> {
  const { error } = await supabase
    .from("thread_participants")
    .upsert({ thread_id: threadId, agent });

  if (error) throw error;

  try {
    broadcastToEllieChatClients({
      type: "thread_updated",
      thread: { id: threadId },
      change: { type: "participant_added", agent },
    });
  } catch { /* best-effort */ }
}

/**
 * Remove an agent from a thread's participants.
 */
export async function removeParticipant(
  supabase: SupabaseClient,
  threadId: string,
  agent: string,
): Promise<void> {
  const { error } = await supabase
    .from("thread_participants")
    .delete()
    .eq("thread_id", threadId)
    .eq("agent", agent);

  if (error) throw error;

  try {
    broadcastToEllieChatClients({
      type: "thread_updated",
      thread: { id: threadId },
      change: { type: "participant_removed", agent },
    });
  } catch { /* best-effort */ }
}

/**
 * Update thread metadata (name, routing_mode, direct_agent).
 */
export async function updateThread(
  supabase: SupabaseClient,
  threadId: string,
  updates: { name?: string; routing_mode?: string; direct_agent?: string | null },
): Promise<void> {
  const { error } = await supabase
    .from("chat_threads")
    .update(updates)
    .eq("id", threadId);

  if (error) throw new Error(error.message);

  try {
    broadcastToEllieChatClients({
      type: "thread_updated",
      thread: { id: threadId, ...updates },
    });
  } catch { /* best-effort */ }

  logger.info("Thread updated", { id: threadId, updates });
}
