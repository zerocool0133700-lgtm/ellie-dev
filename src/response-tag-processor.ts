/**
 * Response Tag Processor — Tier 2 Conversation Facts
 *
 * Parses agent response tags ([REMEMBER:], [GOAL:], [DONE:]) and stores them
 * to the `conversation_facts` table (Tier 2 memory system).
 *
 * This intercepts agent responses AFTER generation but BEFORE sending to the user,
 * extracts memory tags, stores the facts, and returns the cleaned response text
 * (with tags stripped for user display).
 *
 * ELLIE-649: Tier 2 tag parsing implementation.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { log } from "./logger.ts";

const logger = log.child("response-tags");

// ── Types ────────────────────────────────────────────────────

type FactType = "fact" | "preference" | "goal" | "completed_goal" | "decision" | "constraint" | "contact";
type FactCategory = "personal" | "work" | "people" | "schedule" | "technical" | "other";

interface ParsedFact {
  content: string;
  type: FactType;
  category: FactCategory;
  confidence: number;
  tags: string[];
  deadline?: string;
}

// ── Tag Parsing ──────────────────────────────────────────────

/**
 * Parse [REMEMBER:] tags from agent response.
 * Tags have confidence 1.0 (agent-directed intent).
 */
function parseRememberTags(text: string): ParsedFact[] {
  const facts: ParsedFact[] = [];

  for (const match of text.matchAll(/\[REMEMBER:\s*(.+?)\]/gi)) {
    const content = match[1].trim();
    if (content.length < 3) continue;

    facts.push({
      content,
      type: classifyFactType(content),
      category: classifyCategory(content),
      confidence: 1.0,
      tags: ["agent-tagged"],
    });
  }

  return facts;
}

/**
 * Parse [GOAL:] tags from agent response.
 * Format: [GOAL: text] or [GOAL: text | DEADLINE: date]
 */
function parseGoalTags(text: string): ParsedFact[] {
  const facts: ParsedFact[] = [];

  for (const match of text.matchAll(/\[GOAL:\s*(.+?)(?:\s*\|\s*DEADLINE:\s*(.+?))?\]/gi)) {
    const content = match[1].trim();
    if (content.length < 3) continue;

    facts.push({
      content,
      type: "goal",
      category: "work",
      confidence: 1.0,
      tags: ["agent-tagged"],
      deadline: match[2]?.trim(),
    });
  }

  return facts;
}

/**
 * Parse [DONE:] tags and mark matching goals as completed.
 */
async function handleDoneTags(supabase: SupabaseClient, text: string): Promise<void> {
  for (const match of text.matchAll(/\[DONE:\s*(.+?)\]/gi)) {
    const searchText = match[1].trim();
    if (searchText.length < 3) continue;

    const { data } = await supabase
      .from("conversation_facts")
      .select("id")
      .eq("type", "goal")
      .eq("status", "active")
      .ilike("content", `%${searchText}%`)
      .limit(1);

    if (data?.[0]) {
      await supabase
        .from("conversation_facts")
        .update({
          type: "completed_goal",
          status: "archived",
          completed_at: new Date().toISOString(),
        })
        .eq("id", data[0].id);

      logger.info("Goal completed via [DONE:] tag", { goalId: data[0].id, search: searchText });
    }
  }
}

// ── Storage ──────────────────────────────────────────────────

/**
 * Store a parsed fact to conversation_facts table.
 */
async function storeFact(
  supabase: SupabaseClient,
  fact: ParsedFact,
  sourceChannel: string,
): Promise<boolean> {
  const content = fact.content.trim().slice(0, 2000);

  const row: Record<string, unknown> = {
    content,
    type: fact.type,
    category: fact.category,
    confidence: fact.confidence,
    source_channel: sourceChannel,
    extraction_method: "tag",
    tags: fact.tags,
    metadata: {
      source: "agent-response",
    },
  };

  if (fact.deadline) {
    try {
      row.deadline = new Date(fact.deadline).toISOString();
    } catch { /* invalid date — skip */ }
  }

  const { data, error } = await supabase
    .from("conversation_facts")
    .insert(row)
    .select("id")
    .single();

  if (error) {
    if (error.code === "23505") return false; // duplicate
    logger.error("Failed to store fact from agent response", { error: error.message, type: fact.type });
    return false;
  }

  logger.info("Fact stored from agent response", {
    id: data?.id,
    type: fact.type,
    category: fact.category,
    source: sourceChannel,
  });

  return true;
}

// ── Main Processor ───────────────────────────────────────────

/**
 * Process agent response tags.
 *
 * 1. Parses [REMEMBER:], [GOAL:], [DONE:] tags from agent response
 * 2. Stores facts/goals to conversation_facts table
 * 3. Handles goal completion via [DONE:] tags
 * 4. Returns cleaned response (tags stripped for user display)
 *
 * @param supabase - Supabase client
 * @param response - Agent response text (may contain tags)
 * @param sourceChannel - Channel where message will be sent (telegram, google-chat, etc.)
 * @returns Cleaned response with tags removed
 */
export async function processResponseTags(
  supabase: SupabaseClient | null,
  response: string,
  sourceChannel: string = "telegram",
): Promise<string> {
  if (!supabase) return response;

  let cleaned = response;

  // Handle [DONE:] tags (goal completion)
  if (/\[DONE:/i.test(response)) {
    await handleDoneTags(supabase, response);
    cleaned = cleaned.replace(/\[DONE:\s*.+?\]/gi, "");
  }

  // Parse [REMEMBER:] tags
  const rememberFacts = parseRememberTags(response);

  // Parse [GOAL:] tags
  const goalFacts = parseGoalTags(response);

  const allFacts = [...rememberFacts, ...goalFacts];

  // Store facts to database
  let stored = 0;
  for (const fact of allFacts) {
    const success = await storeFact(supabase, fact, sourceChannel);
    if (success) stored++;
  }

  if (stored > 0) {
    logger.info("Stored facts from agent response", { count: stored, channel: sourceChannel });
  }

  // Strip tags from response
  cleaned = cleaned.replace(/\[REMEMBER:\s*.+?\]/gi, "");
  cleaned = cleaned.replace(/\[GOAL:\s*.+?(?:\s*\|\s*DEADLINE:\s*.+?)?\]/gi, "");

  // Clean up any double spaces or trailing whitespace from tag removal
  cleaned = cleaned.replace(/\s{2,}/g, " ").trim();

  // Fix markdown formatting (ELLIE-787)
  const { fixMarkdown } = await import("./markdown-fixer.ts");
  cleaned = fixMarkdown(cleaned);

  return cleaned;
}

// ── Classifiers ──────────────────────────────────────────────

function classifyFactType(content: string): FactType {
  const lower = content.toLowerCase();
  if (/\b(prefer|like|love|hate|don'?t like|favorite|always use)\b/.test(lower)) return "preference";
  if (/\b(decided|decision|go with|chose|will use)\b/.test(lower)) return "decision";
  if (/\b(can'?t|unavailable|not available|off on|don'?t schedule)\b/.test(lower)) return "constraint";
  if (/\b(is the|works at|is a|is my|is our)\b/.test(lower) && !/\bi\s/.test(lower)) return "contact";
  return "fact";
}

function classifyCategory(content: string): FactCategory {
  const lower = content.toLowerCase();
  if (/\b(meeting|appointment|schedule|deadline|flight|trip|vacation|conference|calendar)\b/.test(lower)) return "schedule";
  if (/\b(work|project|code|deploy|server|database|api|ellie|repo|branch|pr|commit)\b/.test(lower)) return "work";
  if (/\b(works at|is the|is a|is my|colleague|friend|family|wife|husband|partner|boss)\b/.test(lower)) return "people";
  if (/\b(redis|postgres|bun|node|typescript|react|vue|docker|kubernetes|aws|api|sdk)\b/.test(lower)) return "technical";
  if (/\b(i am|i live|my home|my car|hobby|birthday|health|doctor|gym)\b/.test(lower)) return "personal";
  return "other";
}

// ── Test-only exports ────────────────────────────────────────

export const _testing = {
  parseRememberTags,
  parseGoalTags,
  classifyFactType,
  classifyCategory,
};
