/**
 * UMS Consumer: GTD Inbox
 *
 * ELLIE-303: Push subscriber — evaluates inbound messages for actionable items
 * and creates GTD inbox entries via the todos table.
 *
 * Listens to: all providers, all content types
 * Action: uses AI (via relay) to decide if a message is actionable, then inserts inbox items
 *
 * Cross-ref: src/api/gtd.ts handleInbox() for the insert shape
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { UnifiedMessage } from "../types.ts";
import { subscribe } from "../events.ts";
import { log } from "../../logger.ts";

const logger = log.child("ums-consumer-gtd");

/** Content types that are likely to contain actionable items. */
const ACTIONABLE_TYPES = new Set(["text", "voice", "task", "notification"]);

/** Providers where messages are often actionable. */
const ACTIONABLE_PROVIDERS = new Set(["telegram", "gmail", "gchat", "voice", "google-tasks"]);

interface InboxItem {
  content: string;
  priority: string | null;
  tags: string[];
  source_type: string;
  source_ref: string | null;
}

/**
 * Initialize the GTD consumer.
 * Subscribes to UMS and evaluates messages for actionable content.
 */
export function initGtdConsumer(supabase: SupabaseClient): void {
  subscribe("consumer:gtd", {}, async (message) => {
    try {
      await handleMessage(supabase, message);
    } catch (err) {
      logger.error("GTD consumer failed", { messageId: message.id, err });
    }
  });
  logger.info("GTD consumer initialized");
}

async function handleMessage(supabase: SupabaseClient, message: UnifiedMessage): Promise<void> {
  // Skip non-actionable content types
  if (!ACTIONABLE_TYPES.has(message.content_type)) return;

  // Skip messages without content
  if (!message.content?.trim()) return;

  // For task-type messages (Google Tasks), always create inbox items
  if (message.content_type === "task") {
    await createInboxItem(supabase, {
      content: message.content,
      priority: null,
      tags: ["imported", `source:${message.provider}`],
      source_type: "ums",
      source_ref: `${message.provider}:${message.provider_id}`,
    });
    return;
  }

  // For other messages, only process from actionable providers
  if (!ACTIONABLE_PROVIDERS.has(message.provider)) return;

  // Extract actionable signals from the message
  const signals = detectActionableSignals(message);
  if (!signals.isActionable) return;

  await createInboxItem(supabase, {
    content: signals.summary || message.content,
    priority: signals.priority,
    tags: ["auto-captured", `source:${message.provider}`, ...signals.tags],
    source_type: "ums",
    source_ref: `${message.provider}:${message.provider_id}`,
  });
}

interface ActionableSignals {
  isActionable: boolean;
  summary: string | null;
  priority: string | null;
  tags: string[];
}

/**
 * Simple heuristic detection of actionable content.
 * Checks for task-like patterns in message text.
 * Future: replace with AI-based classification via relay.
 */
function detectActionableSignals(message: UnifiedMessage): ActionableSignals {
  const text = (message.content || "").toLowerCase();
  const tags: string[] = [];

  // Check for explicit task markers
  const taskPatterns = [
    /\btodo\b/i, /\baction item\b/i, /\bfollow up\b/i, /\breminder\b/i,
    /\bdeadline\b/i, /\bdue by\b/i, /\bplease\s+(do|send|review|check|update|fix|add|create)\b/i,
    /\bneed to\b/i, /\bdon't forget\b/i, /\bmake sure\b/i,
  ];

  const hasTaskPattern = taskPatterns.some(p => p.test(text));

  // Check for urgency signals
  const urgentPatterns = [/\burgent\b/i, /\basap\b/i, /\bimmediately\b/i, /\bcritical\b/i];
  const isUrgent = urgentPatterns.some(p => p.test(text));
  if (isUrgent) tags.push("urgent");

  // Notifications about mentions or shares are often actionable
  const isMention = message.content_type === "notification" &&
    (message.metadata?.change_type === "mention" || message.metadata?.change_type === "share");

  if (!hasTaskPattern && !isMention) {
    return { isActionable: false, summary: null, priority: null, tags };
  }

  return {
    isActionable: true,
    summary: null, // Use original content
    priority: isUrgent ? "high" : null,
    tags,
  };
}

async function createInboxItem(supabase: SupabaseClient, item: InboxItem): Promise<void> {
  const { error } = await supabase.from("todos").insert({
    content: item.content.trim().slice(0, 2000),
    status: "inbox",
    priority: item.priority,
    tags: item.tags,
    source_type: item.source_type,
    source_ref: item.source_ref,
  });

  if (error) {
    logger.error("GTD consumer: failed to create inbox item", { error: error.message });
    return;
  }

  logger.info("GTD consumer: inbox item created", {
    source: item.source_ref,
    tags: item.tags,
  });
}
