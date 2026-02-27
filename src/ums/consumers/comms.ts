/**
 * UMS Consumer: Comms Assistant
 *
 * ELLIE-308: Push subscriber — tracks conversation thread state
 * and identifies unanswered threads that need follow-up.
 *
 * Listens to: text messages from conversational channels
 * Action: maintains thread tracking table, flags stale unanswered threads
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { UnifiedMessage } from "../types.ts";
import { subscribe } from "../events.ts";
import { log } from "../../logger.ts";

const logger = log.child("ums-consumer-comms");

/** Channels where thread tracking makes sense. */
const THREADED_PROVIDERS = new Set(["telegram", "gchat", "gmail"]);

/** How long before a thread is considered stale (ms). */
const STALE_THRESHOLD_MS = 4 * 60 * 60 * 1000; // 4 hours

interface ThreadState {
  thread_id: string;
  provider: string;
  channel: string | null;
  last_message_at: string;
  last_sender: string | null;
  message_count: number;
  awaiting_reply: boolean;
  first_seen: string;
}

/** In-memory thread tracker. Persisted to DB periodically. */
const threads = new Map<string, ThreadState>();

/**
 * Initialize the Comms Assistant consumer.
 */
export function initCommsConsumer(supabase: SupabaseClient): void {
  subscribe("consumer:comms", {}, async (message) => {
    try {
      await handleMessage(supabase, message);
    } catch (err) {
      logger.error("Comms consumer failed", { messageId: message.id, err });
    }
  });
  logger.info("Comms consumer initialized");
}

async function handleMessage(_supabase: SupabaseClient, message: UnifiedMessage): Promise<void> {
  if (!THREADED_PROVIDERS.has(message.provider)) return;
  if (message.content_type !== "text" && message.content_type !== "voice") return;

  const threadId = resolveThreadId(message);
  const senderName = message.sender?.name || message.sender?.username || message.sender?.email || null;
  const now = new Date().toISOString();

  const existing = threads.get(threadId);
  if (existing) {
    existing.last_message_at = now;
    existing.last_sender = senderName;
    existing.message_count++;
    // If Dave replied, no longer awaiting reply
    existing.awaiting_reply = !isDave(message);
  } else {
    threads.set(threadId, {
      thread_id: threadId,
      provider: message.provider,
      channel: message.channel,
      last_message_at: now,
      last_sender: senderName,
      message_count: 1,
      awaiting_reply: !isDave(message),
      first_seen: now,
    });
  }
}

/**
 * Get threads that are awaiting a reply and have been stale.
 * Called on schedule (e.g., by briefing consumer).
 */
export function getStaleThreads(): ThreadState[] {
  const now = Date.now();
  const stale: ThreadState[] = [];

  for (const thread of threads.values()) {
    if (!thread.awaiting_reply) continue;
    const lastAt = new Date(thread.last_message_at).getTime();
    if (now - lastAt > STALE_THRESHOLD_MS) {
      stale.push(thread);
    }
  }

  return stale.sort((a, b) =>
    new Date(a.last_message_at).getTime() - new Date(b.last_message_at).getTime()
  );
}

/** Get all active thread states. */
export function getActiveThreads(): ThreadState[] {
  return Array.from(threads.values());
}

function resolveThreadId(message: UnifiedMessage): string {
  // Use thread-specific metadata if available
  const meta = message.metadata || {};
  if (meta.thread_name) return `${message.provider}:${meta.thread_name}`;
  if (meta.thread_id) return `${message.provider}:${meta.thread_id}`;
  if (meta.conversation_id) return `${message.provider}:${meta.conversation_id}`;

  // Fall back to channel as thread ID
  return message.channel || `${message.provider}:${message.provider_id}`;
}

/** Check if the message sender is Dave (the user). */
function isDave(message: UnifiedMessage): boolean {
  const s = message.sender;
  if (!s) return false;
  const name = (s.name || "").toLowerCase();
  const email = (s.email || "").toLowerCase();
  return name.includes("dave") || email.includes("dave");
}
