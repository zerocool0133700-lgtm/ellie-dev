/**
 * UMS Consumer: Memory
 *
 * ELLIE-304: Push subscriber — extracts personal facts and preferences
 * from conversational messages and stores them in the memory system.
 *
 * Listens to: text + voice messages from conversational channels
 * Action: detects factual statements and writes to memory table
 *
 * Cross-ref: src/memory.ts for memory storage + dedup (DEDUP_SIMILARITY_THRESHOLD = 0.85)
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { UnifiedMessage } from "../types.ts";
import { subscribe } from "../events.ts";
import { log } from "../../logger.ts";

const logger = log.child("ums-consumer-memory");

/** Only conversational channels produce useful personal facts. */
const CONVERSATIONAL_PROVIDERS = new Set(["telegram", "gchat", "voice"]);

/** Minimum content length to bother analyzing. */
const MIN_CONTENT_LENGTH = 20;

/**
 * Initialize the Memory consumer.
 * Subscribes to conversational messages and extracts facts.
 */
export function initMemoryConsumer(supabase: SupabaseClient): void {
  subscribe("consumer:memory", {}, async (message) => {
    try {
      await handleMessage(supabase, message);
    } catch (err) {
      logger.error("Memory consumer failed", { messageId: message.id, err });
    }
  });
  logger.info("Memory consumer initialized");
}

async function handleMessage(supabase: SupabaseClient, message: UnifiedMessage): Promise<void> {
  // Only process conversational content
  if (!CONVERSATIONAL_PROVIDERS.has(message.provider)) return;
  if (message.content_type !== "text" && message.content_type !== "voice") return;
  if (!message.content || message.content.length < MIN_CONTENT_LENGTH) return;

  // Extract fact-like statements using pattern detection
  const facts = extractFacts(message.content);
  if (facts.length === 0) return;

  for (const fact of facts) {
    await storeFact(supabase, fact, message);
  }
}

interface ExtractedFact {
  content: string;
  type: "fact" | "preference";
  confidence: number;
}

/**
 * Simple pattern-based fact extraction.
 * Looks for self-referential statements that indicate personal facts or preferences.
 * Future: replace with AI-based extraction via relay.
 */
function extractFacts(text: string): ExtractedFact[] {
  const facts: ExtractedFact[] = [];
  const sentences = text.split(/[.!?\n]+/).map(s => s.trim()).filter(Boolean);

  for (const sentence of sentences) {
    const lower = sentence.toLowerCase();

    // Preference patterns: "I prefer X", "I like X", "I don't like X"
    if (/\bi\s+(prefer|like|love|hate|don'?t like|always|never)\b/i.test(sentence)) {
      facts.push({ content: sentence, type: "preference", confidence: 0.7 });
      continue;
    }

    // Fact patterns: "I am X", "I have X", "I work at X", "My X is Y"
    if (/\b(i\s+(am|have|work|live|use|need)|my\s+\w+\s+(is|are))\b/i.test(sentence)) {
      facts.push({ content: sentence, type: "fact", confidence: 0.6 });
      continue;
    }

    // Schedule patterns: "I have a meeting", "My dentist appointment"
    if (/\b(appointment|meeting|flight|trip|vacation|birthday)\b/i.test(lower) &&
        /\b(my|i|i'm|i've)\b/i.test(lower)) {
      facts.push({ content: sentence, type: "fact", confidence: 0.5 });
    }
  }

  return facts;
}

async function storeFact(
  supabase: SupabaseClient,
  fact: ExtractedFact,
  source: UnifiedMessage,
): Promise<void> {
  const { error } = await supabase.from("memory").insert({
    content: fact.content.trim().slice(0, 1000),
    type: fact.type,
    source_agent: "ums-memory-consumer",
    visibility: "internal",
    metadata: {
      confidence: fact.confidence,
      source_provider: source.provider,
      source_channel: source.channel,
      source_message_id: source.id,
      extracted_at: new Date().toISOString(),
    },
  });

  if (error) {
    // Duplicate or dedup conflict — not a real error
    if (error.code === "23505") return;
    logger.error("Memory consumer: failed to store fact", { error: error.message });
    return;
  }

  logger.info("Memory consumer: fact stored", {
    type: fact.type,
    confidence: fact.confidence,
    source: source.provider,
  });
}
