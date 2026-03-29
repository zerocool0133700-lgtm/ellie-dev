/**
 * Message Refiner — ELLIE-1135
 *
 * Background refinement of user messages via Haiku.
 * Raw text preserved in raw_messages, clean markdown in messages.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { log } from "./logger.ts";

const logger = log.child("message-refiner");

const REFINE_SYSTEM_PROMPT = `You clean up raw conversational messages into clear, readable markdown.
Rules:
- Keep first-person voice — this should still sound like the speaker
- Fix grammar, spelling, punctuation
- Break run-on sentences into coherent ones
- Add markdown formatting where helpful (bullets, headers for long messages)
- Don't add information, opinions, or change meaning
- Don't add a title or wrap in code blocks
- For short messages (under ~20 words), just fix grammar and return — don't over-format
- Return ONLY the cleaned text, nothing else`;

let _anthropic: Anthropic | null = null;
let _supabase: SupabaseClient | null = null;

export function initMessageRefiner(anthropic: Anthropic, supabase: SupabaseClient): void {
  _anthropic = anthropic;
  _supabase = supabase;
  logger.info("Initialized");
}

async function refineWithHaiku(rawText: string): Promise<string> {
  if (!_anthropic) throw new Error("Anthropic client not initialized");

  const response = await _anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 2048,
    system: REFINE_SYSTEM_PROMPT,
    messages: [{ role: "user", content: rawText }],
  });

  const block = response.content[0];
  if (block.type !== "text") throw new Error("Unexpected response type");
  return block.text;
}

export async function refineAndStoreMessage(
  messageId: string,
  rawText: string,
  channel: string,
): Promise<void> {
  if (!_supabase || !_anthropic) {
    logger.warn("Refiner not initialized, skipping", { messageId });
    return;
  }

  try {
    // 1. Store raw message
    const { error: rawErr } = await _supabase
      .from("raw_messages")
      .insert({ id: messageId, content: rawText });

    if (rawErr) {
      logger.warn("Failed to store raw message", { messageId, error: rawErr.message });
      return;
    }

    // 2. Refine with Haiku
    const refined = await refineWithHaiku(rawText);

    // 3. Update messages table with refined content
    const { error: updateErr } = await _supabase
      .from("messages")
      .update({ content: refined })
      .eq("id", messageId);

    if (updateErr) {
      logger.warn("Failed to update message with refined content", { messageId, error: updateErr.message });
      return;
    }

    logger.info("Message refined", { messageId, channel, rawLen: rawText.length, refinedLen: refined.length });
  } catch (err) {
    logger.warn("Message refinement failed", { messageId, error: (err as Error).message });
  }
}
