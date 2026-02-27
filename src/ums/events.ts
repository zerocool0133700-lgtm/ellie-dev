/**
 * UMS — Event Subscription System (push + pull)
 *
 * ELLIE-295: Downstream consumers get messages two ways:
 *   - Push: register a handler with filters, get called when matching messages arrive
 *   - Pull: query the unified_messages table with filters on your own schedule
 *
 * Push is an in-process EventEmitter — no external queue. If a push handler
 * fails, the consumer can catch up via pull. Simple beats complex.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { UnifiedMessage, MessageQueryFilters, Provider, ContentType } from "./types.ts";
import { log } from "../logger.ts";

const logger = log.child("ums-events");

// ── Push Subscriptions ─────────────────────────────────────────

/** Filter criteria for push subscriptions. All fields optional — omitted = match all. */
export interface SubscriptionFilter {
  provider?: Provider;
  content_type?: ContentType;
  /** Glob-style channel match (e.g., "gmail:*" or exact "telegram:12345"). */
  channel?: string;
}

export type MessageHandler = (message: UnifiedMessage) => void | Promise<void>;

interface Subscription {
  name: string;
  filter: SubscriptionFilter;
  handler: MessageHandler;
}

const subscriptions: Subscription[] = [];

/**
 * Register a push subscriber.
 * The handler fires for every new UnifiedMessage matching the filter.
 * Handlers should be fast and non-blocking — failures are logged, not retried.
 */
export function subscribe(name: string, filter: SubscriptionFilter, handler: MessageHandler): void {
  subscriptions.push({ name, filter, handler });
  logger.info("UMS subscriber registered", { name, filter });
}

/** Remove a subscriber by name. */
export function unsubscribe(name: string): void {
  const idx = subscriptions.findIndex(s => s.name === name);
  if (idx >= 0) {
    subscriptions.splice(idx, 1);
    logger.info("UMS subscriber removed", { name });
  }
}

/** List registered subscriber names. */
export function listSubscribers(): string[] {
  return subscriptions.map(s => s.name);
}

/**
 * Notify all matching subscribers of a new message.
 * Called internally by the ingest function after a successful insert.
 * Each handler runs independently — one failure doesn't block others.
 */
export async function notify(message: UnifiedMessage): Promise<void> {
  for (const sub of subscriptions) {
    if (!matchesFilter(message, sub.filter)) continue;
    try {
      await sub.handler(message);
    } catch (err) {
      logger.error("UMS subscriber handler failed", { subscriber: sub.name, messageId: message.id, err });
    }
  }
}

function matchesFilter(message: UnifiedMessage, filter: SubscriptionFilter): boolean {
  if (filter.provider && message.provider !== filter.provider) return false;
  if (filter.content_type && message.content_type !== filter.content_type) return false;
  if (filter.channel) {
    if (!message.channel) return false;
    if (filter.channel.endsWith("*")) {
      const prefix = filter.channel.slice(0, -1);
      if (!message.channel.startsWith(prefix)) return false;
    } else if (message.channel !== filter.channel) {
      return false;
    }
  }
  return true;
}

// ── Pull Queries ───────────────────────────────────────────────

const MAX_PULL_LIMIT = 500;
const DEFAULT_PULL_LIMIT = 50;

/**
 * Query unified_messages with filters. For batch consumers (briefing, analytics)
 * that pull on their own schedule.
 */
export async function queryMessages(
  supabase: SupabaseClient,
  filters: MessageQueryFilters = {},
): Promise<UnifiedMessage[]> {
  const limit = Math.min(filters.limit || DEFAULT_PULL_LIMIT, MAX_PULL_LIMIT);

  let query = supabase
    .from("unified_messages")
    .select("*")
    .order("received_at", { ascending: false })
    .limit(limit);

  if (filters.provider) query = query.eq("provider", filters.provider);
  if (filters.content_type) query = query.eq("content_type", filters.content_type);
  if (filters.channel) query = query.eq("channel", filters.channel);
  if (filters.since) query = query.gte("received_at", filters.since);
  if (filters.before) query = query.lte("received_at", filters.before);

  const { data, error } = await query;

  if (error) {
    logger.error("UMS pull query failed", { filters, error: error.message });
    return [];
  }

  return (data || []) as UnifiedMessage[];
}
