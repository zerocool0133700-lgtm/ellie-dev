/**
 * UMS Consumer: Memory Module
 *
 * ELLIE-323: Enhanced memory extraction engine — extracts facts, preferences,
 * goals, decisions, constraints, and contacts from conversational messages.
 *
 * Stores to `conversation_facts` table with structured types, categories,
 * confidence scoring, and conflict detection. High-confidence facts sync
 * to Forest for long-term institutional memory.
 *
 * Phase 1:
 *   - Tag parsing: [REMEMBER:], [GOAL:], [DONE:] → confidence 1.0
 *   - Pattern extraction: self-referential statements → confidence 0.5-0.7
 *   - Forest sync: facts with confidence >= 0.8 pushed to shared_memories
 *   - In-memory cache: live counts for summary bar
 *
 * Phase 2 (Intelligence Layer):
 *   - Cross-channel consolidation: dedup facts from Telegram/Gmail/Chat
 *   - Auto-conflict resolution: updates keep newer, clarifications merge,
 *     contradictions surface to user
 *   - Memory health scoring: confidence avg, stale facts, conflict rate
 *   - Smart goal tracking: auto-detect goal completion from conversation
 *
 * Cross-ref: src/memory.ts for legacy tag parsing (processMemoryIntents)
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { UnifiedMessage } from "../types.ts";
import { subscribe } from "../events.ts";
import { log } from "../../logger.ts";

const logger = log.child("ums-consumer-memory");

// ── Config ────────────────────────────────────────────────────

/** Only conversational channels produce useful personal facts. */
const CONVERSATIONAL_PROVIDERS = new Set(["telegram", "gchat", "voice"]);

/** Minimum content length to bother analyzing. */
const MIN_CONTENT_LENGTH = 15;

/** Confidence threshold for Forest sync. */
const FOREST_SYNC_THRESHOLD = 0.8;

/** Similarity threshold for cross-channel dedup / conflict detection. */
const DEDUP_SIMILARITY_THRESHOLD = 0.85;

/** Above this threshold, facts are near-identical → always merge. */
const AUTO_MERGE_THRESHOLD = 0.93;

/** Days after which a fact is considered stale (no updates). */
const STALE_FACT_DAYS = 30;

// ── Types ─────────────────────────────────────────────────────

type FactType = "fact" | "preference" | "goal" | "completed_goal" | "decision" | "constraint" | "contact";
type FactCategory = "personal" | "work" | "people" | "schedule" | "technical" | "other";
type ExtractionMethod = "tag" | "pattern" | "ai" | "manual";

interface ExtractedFact {
  content: string;
  type: FactType;
  category: FactCategory;
  confidence: number;
  extraction_method: ExtractionMethod;
  tags: string[];
  deadline?: string;
}

export interface ConversationFact {
  id: string;
  content: string;
  type: FactType;
  category: FactCategory | null;
  confidence: number;
  source_channel: string | null;
  extraction_method: ExtractionMethod;
  status: string;
  tags: string[];
  deadline: string | null;
  completed_at: string | null;
  forest_memory_id: string | null;
  created_at: string;
  updated_at: string;
}

// ── In-memory cache for summary bar ───────────────────────────

export interface MemoryHealth {
  avgConfidence: number;
  staleFacts: number;
  conflictRate: number;       // open conflicts / total active facts
  tagCoverage: number;        // % of facts that have at least one tag
  forestSyncRate: number;     // % of eligible facts synced to Forest
  totalActive: number;
  lastHealthCheck: string | null;
}

interface MemoryStats {
  factCount: number;
  goalCount: number;
  conflictCount: number;
  overdueGoals: number;
  lastExtraction: string | null;
  health: MemoryHealth;
}

const stats: MemoryStats = {
  factCount: 0,
  goalCount: 0,
  conflictCount: 0,
  overdueGoals: 0,
  lastExtraction: null,
  health: {
    avgConfidence: 0,
    staleFacts: 0,
    conflictRate: 0,
    tagCoverage: 0,
    forestSyncRate: 0,
    totalActive: 0,
    lastHealthCheck: null,
  },
};

let supabaseRef: SupabaseClient | null = null;

// ── Public getters for summary bar ────────────────────────────

export function getFactCount(): number { return stats.factCount; }
export function getGoalCount(): number { return stats.goalCount; }
export function getConflictCount(): number { return stats.conflictCount; }
export function getOverdueGoalCount(): number { return stats.overdueGoals; }
export function getLastExtraction(): string | null { return stats.lastExtraction; }
export function getMemoryHealth(): MemoryHealth { return { ...stats.health }; }
export function getMemoryStats(): MemoryStats { return { ...stats, health: { ...stats.health } }; }

// ── Init ──────────────────────────────────────────────────────

/**
 * Initialize the Memory consumer.
 * Subscribes to conversational messages and extracts facts.
 */
export function initMemoryConsumer(supabase: SupabaseClient): void {
  supabaseRef = supabase;

  subscribe("consumer:memory", {}, async (message) => {
    try {
      await handleMessage(supabase, message);
    } catch (err) {
      logger.error("Memory consumer failed", { messageId: message.id, err });
    }
  });

  // Load initial stats from DB
  refreshStats(supabase).catch(() => {});

  // Periodic stats refresh + Forest sync (every 10 min)
  setInterval(() => {
    refreshStats(supabase).catch(() => {});
    syncToForest(supabase).catch(() => {});
  }, 10 * 60 * 1000);

  // Phase 2: Health scoring + cross-channel consolidation (every 30 min)
  setInterval(() => {
    computeHealthScore(supabase).catch(() => {});
    consolidateCrossChannel(supabase).catch(() => {});
  }, 30 * 60 * 1000);

  // Initial health check after a short delay
  setTimeout(() => computeHealthScore(supabase).catch(() => {}), 15_000);

  logger.info("Memory consumer initialized (ELLIE-323 Phase 1+2)");
}

// ── Message handler ───────────────────────────────────────────

async function handleMessage(supabase: SupabaseClient, message: UnifiedMessage): Promise<void> {
  // Only process conversational content
  if (!CONVERSATIONAL_PROVIDERS.has(message.provider)) return;
  if (message.content_type !== "text" && message.content_type !== "voice") return;
  if (!message.content || message.content.length < MIN_CONTENT_LENGTH) return;

  // Process [DONE:] tags first (goal completion)
  if (/\[DONE:/i.test(message.content)) {
    await handleDoneTags(supabase, message.content);
  }

  // Phase 2: Smart goal tracking — detect implicit goal completion
  await detectGoalCompletion(supabase, message.content);

  // Tag parsing (always active, confidence 1.0)
  const tagFacts = parseTags(message.content);

  // Pattern-based extraction (confidence 0.5-0.7)
  const patternFacts = extractPatterns(message.content);

  const allFacts = [...tagFacts, ...patternFacts];
  if (allFacts.length === 0) return;

  let stored = 0;
  for (const fact of allFacts) {
    const success = await storeFact(supabase, fact, message);
    if (success) stored++;
  }

  if (stored > 0) {
    stats.lastExtraction = new Date().toISOString();
    // Refresh counts after storing
    await refreshStats(supabase).catch(() => {});
  }
}

// ── Tag parsing ───────────────────────────────────────────────

/**
 * Parse explicit memory tags from message text.
 * Tags have confidence 1.0 (user-directed intent).
 */
function parseTags(text: string): ExtractedFact[] {
  const facts: ExtractedFact[] = [];

  // [REMEMBER: text] → fact with confidence 1.0
  for (const match of text.matchAll(/\[REMEMBER:\s*(.+?)\]/gi)) {
    const content = match[1].trim();
    if (content.length < 3) continue;
    facts.push({
      content,
      type: classifyFactType(content),
      category: classifyCategory(content),
      confidence: 1.0,
      extraction_method: "tag",
      tags: ["user-tagged"],
    });
  }

  // [GOAL: text] or [GOAL: text | DEADLINE: date]
  for (const match of text.matchAll(/\[GOAL:\s*(.+?)(?:\s*\|\s*DEADLINE:\s*(.+?))?\]/gi)) {
    facts.push({
      content: match[1].trim(),
      type: "goal",
      category: "work",
      confidence: 1.0,
      extraction_method: "tag",
      tags: ["user-tagged"],
      deadline: match[2]?.trim(),
    });
  }

  // [DONE: search text] → handled specially (marks goal complete)
  // Processed separately in handleDoneTags

  return facts;
}

/**
 * Process [DONE:] tags to mark matching goals as completed.
 */
async function handleDoneTags(supabase: SupabaseClient, text: string): Promise<void> {
  for (const match of text.matchAll(/\[DONE:\s*(.+?)\]/gi)) {
    const searchText = match[1].trim();

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

      stats.goalCount = Math.max(0, stats.goalCount - 1);
      logger.info("Goal completed via [DONE:] tag", { goalId: data[0].id, search: searchText });
    }
  }
}

// ── Pattern extraction ────────────────────────────────────────

/**
 * Pattern-based fact extraction from natural language.
 * Looks for self-referential statements indicating personal facts or preferences.
 */
function extractPatterns(text: string): ExtractedFact[] {
  const facts: ExtractedFact[] = [];
  const sentences = text.split(/[.!?\n]+/).map(s => s.trim()).filter(s => s.length >= 10);

  for (const sentence of sentences) {
    const lower = sentence.toLowerCase();

    // Skip if it looks like a question
    if (sentence.endsWith("?") || /\b(what|where|when|why|how|who|can you|do you)\b/i.test(lower)) continue;

    // Preference patterns: "I prefer X", "I like X", "I don't like X"
    if (/\bi\s+(prefer|like|love|hate|don'?t like|always use|never use|always|never)\b/i.test(sentence)) {
      facts.push({
        content: sentence,
        type: "preference",
        category: classifyCategory(sentence),
        confidence: 0.7,
        extraction_method: "pattern",
        tags: inferTags(sentence),
      });
      continue;
    }

    // Decision patterns: "Let's go with X", "I've decided", "We'll use X"
    if (/\b(let'?s\s+go\s+with|i'?ve\s+decided|we'?ll\s+use|decided\s+to|going\s+with)\b/i.test(sentence)) {
      facts.push({
        content: sentence,
        type: "decision",
        category: classifyCategory(sentence),
        confidence: 0.7,
        extraction_method: "pattern",
        tags: inferTags(sentence),
      });
      continue;
    }

    // Constraint patterns: "I can't do X on Y", "I'm not available", "Don't schedule"
    if (/\b(i\s+can'?t|i'?m\s+not\s+available|don'?t\s+schedule|unavailable|off\s+on)\b/i.test(sentence)) {
      facts.push({
        content: sentence,
        type: "constraint",
        category: "schedule",
        confidence: 0.7,
        extraction_method: "pattern",
        tags: ["schedule"],
      });
      continue;
    }

    // Contact/people patterns: "X is the VP at Y", "X works at Y"
    if (/\b(\w+)\s+(is\s+the|works\s+at|is\s+a|is\s+my|is\s+our)\b/i.test(sentence) &&
        !/\bi\s/i.test(sentence)) {
      facts.push({
        content: sentence,
        type: "contact",
        category: "people",
        confidence: 0.6,
        extraction_method: "pattern",
        tags: ["person"],
      });
      continue;
    }

    // Fact patterns: "I am X", "I have X", "I work at X", "My X is Y"
    if (/\b(i\s+(am|have|work|live|use|need|started|switched|moved)|my\s+\w+\s+(is|are))\b/i.test(sentence)) {
      facts.push({
        content: sentence,
        type: "fact",
        category: classifyCategory(sentence),
        confidence: 0.6,
        extraction_method: "pattern",
        tags: inferTags(sentence),
      });
      continue;
    }

    // Schedule patterns: "I have a meeting", "My dentist appointment"
    if (/\b(appointment|meeting|flight|trip|vacation|birthday|conference|deadline)\b/i.test(lower) &&
        /\b(my|i|i'm|i've|we)\b/i.test(lower)) {
      facts.push({
        content: sentence,
        type: "fact",
        category: "schedule",
        confidence: 0.5,
        extraction_method: "pattern",
        tags: ["schedule"],
      });
    }
  }

  return facts;
}

// ── Storage (with Phase 2 conflict detection) ─────────────────

async function storeFact(
  supabase: SupabaseClient,
  fact: ExtractedFact,
  source: UnifiedMessage,
): Promise<boolean> {
  const content = fact.content.trim().slice(0, 2000);

  // Phase 2: Check for similar existing facts before insert
  const conflict = await checkForConflict(supabase, content, fact.type, source.provider);
  if (conflict) {
    // Conflict was handled (merged, auto-resolved, or flagged) — skip insert
    return conflict.action !== "skip";
  }

  const row: Record<string, unknown> = {
    content,
    type: fact.type,
    category: fact.category,
    confidence: fact.confidence,
    source_channel: source.provider,
    source_message_id: source.id,
    extraction_method: fact.extraction_method,
    tags: fact.tags,
    metadata: {
      source_channel_detail: source.channel,
      sender: source.sender,
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
    logger.error("Failed to store fact", { error: error.message, type: fact.type });
    return false;
  }

  logger.info("Fact stored", {
    id: data?.id,
    type: fact.type,
    category: fact.category,
    confidence: fact.confidence,
    method: fact.extraction_method,
    source: source.provider,
  });

  return true;
}

// ── Phase 2: Cross-channel conflict detection ─────────────────

interface ConflictCheckResult {
  action: "merged" | "conflict_created" | "auto_resolved" | "skip";
  existingId?: string;
}

/**
 * Check if a similar fact already exists. Handles:
 *   1. Near-identical (>= AUTO_MERGE_THRESHOLD): merge silently (cross-channel dedup)
 *   2. Similar but different channel (>= DEDUP_THRESHOLD): merge + boost confidence
 *   3. Similar but contradictory: auto-resolve or create conflict record
 *
 * Uses Supabase Edge Function for embedding search. Falls through to text
 * comparison if embeddings unavailable.
 */
async function checkForConflict(
  supabase: SupabaseClient,
  content: string,
  type: string,
  sourceChannel: string,
): Promise<ConflictCheckResult | null> {
  try {
    // Try embedding-based similarity search via Edge Function
    const { data: similar, error } = await supabase.functions.invoke("search", {
      body: {
        query: content,
        table: "conversation_facts",
        match_count: 3,
        match_threshold: DEDUP_SIMILARITY_THRESHOLD,
      },
    });

    if (error || !similar?.length) {
      // Fallback: text-based dedup check
      return await textBasedDedup(supabase, content, type);
    }

    // Find best match of same type
    const best = similar.find((m: { type?: string }) => m.type === type) || similar[0];
    const similarity = best.similarity || 0;

    if (similarity < DEDUP_SIMILARITY_THRESHOLD) return null;

    // Near-identical → silent merge (cross-channel dedup)
    if (similarity >= AUTO_MERGE_THRESHOLD) {
      await mergeFact(supabase, best.id, content, sourceChannel, similarity);
      return { action: "merged", existingId: best.id };
    }

    // Similar but not identical → classify conflict type
    return await resolveFactConflict(supabase, best, content, type, sourceChannel, similarity);
  } catch {
    // Embedding search unavailable — try text dedup
    return await textBasedDedup(supabase, content, type);
  }
}

/**
 * Fallback text-based dedup when embeddings are unavailable.
 * Uses ILIKE to find near-identical content.
 */
async function textBasedDedup(
  supabase: SupabaseClient,
  content: string,
  type: string,
): Promise<ConflictCheckResult | null> {
  // Exact or near-exact text match
  const normalized = content.toLowerCase().replace(/[^\w\s]/g, "").trim();
  if (normalized.length < 10) return null;

  const { data } = await supabase
    .from("conversation_facts")
    .select("id, content, source_channel")
    .eq("type", type)
    .eq("status", "active")
    .ilike("content", `%${normalized.slice(0, 60)}%`)
    .limit(1);

  if (!data?.[0]) return null;

  // Check if content is genuinely similar (not just substring match)
  const existingNorm = data[0].content.toLowerCase().replace(/[^\w\s]/g, "").trim();
  const shorter = Math.min(normalized.length, existingNorm.length);
  const longer = Math.max(normalized.length, existingNorm.length);
  if (shorter / longer < 0.7) return null; // length ratio too different

  // Merge silently
  return { action: "skip", existingId: data[0].id };
}

/**
 * Merge a new fact into an existing one (cross-channel consolidation).
 * Boosts confidence, tracks additional source channel.
 */
async function mergeFact(
  supabase: SupabaseClient,
  existingId: string,
  newContent: string,
  sourceChannel: string,
  similarity: number,
): Promise<void> {
  // Fetch existing fact
  const { data: existing } = await supabase
    .from("conversation_facts")
    .select("confidence, metadata, source_channel")
    .eq("id", existingId)
    .single();

  if (!existing) return;

  const meta = (existing.metadata || {}) as Record<string, unknown>;
  const channels = new Set<string>(
    Array.isArray(meta.source_channels) ? meta.source_channels as string[] : [],
  );
  if (existing.source_channel) channels.add(existing.source_channel);
  channels.add(sourceChannel);

  // Boost confidence by corroboration (cap at 1.0)
  const boostedConfidence = Math.min(1.0, (existing.confidence || 0.7) + 0.05);

  await supabase
    .from("conversation_facts")
    .update({
      confidence: boostedConfidence,
      // Prefer longer content (more detail)
      ...(newContent.length > (existing as unknown as { content?: string }).content?.length * 1.2
        ? { content: newContent, embedding: null }
        : {}),
      metadata: {
        ...meta,
        source_channels: [...channels],
        last_corroborated_at: new Date().toISOString(),
        corroboration_count: ((meta.corroboration_count as number) || 0) + 1,
        last_similarity: similarity,
      },
    })
    .eq("id", existingId);

  logger.info("Fact merged (cross-channel)", {
    existingId: existingId.slice(0, 8),
    channels: [...channels],
    confidence: boostedConfidence,
  });
}

/**
 * Classify and resolve a conflict between similar facts.
 *
 * Resolution strategy:
 *   - Same type, content is an update (newer info): auto-resolve, keep newer
 *   - Same type, content adds detail: auto-merge (clarification)
 *   - Different or contradictory: create conflict record for user
 */
async function resolveFactConflict(
  supabase: SupabaseClient,
  existing: { id: string; content: string; type?: string; confidence?: number },
  newContent: string,
  newType: string,
  sourceChannel: string,
  similarity: number,
): Promise<ConflictCheckResult> {
  // Same channel, very similar → just a rephrasing, skip
  const { data: existingFull } = await supabase
    .from("conversation_facts")
    .select("id, source_channel, created_at")
    .eq("id", existing.id)
    .single();

  if (existingFull?.source_channel === sourceChannel) {
    return { action: "skip", existingId: existing.id };
  }

  // Classify conflict type based on content analysis
  const conflictType = classifyConflictType(existing.content, newContent);

  if (conflictType === "update") {
    // Auto-resolve: newer fact supersedes older
    // Insert the new fact first
    const { data: newFact } = await supabase
      .from("conversation_facts")
      .insert({
        content: newContent,
        type: newType,
        category: classifyCategory(newContent),
        confidence: 0.8,
        source_channel: sourceChannel,
        extraction_method: "pattern" as ExtractionMethod,
        tags: inferTags(newContent),
      })
      .select("id")
      .single();

    if (newFact) {
      // Supersede the old fact
      await supabase.from("conversation_facts")
        .update({ status: "superseded", superseded_by: newFact.id })
        .eq("id", existing.id);

      // Record the auto-resolution
      await supabase.from("memory_conflicts").insert({
        fact_a_id: existing.id,
        fact_b_id: newFact.id,
        similarity,
        conflict_type: "update",
        status: "resolved",
        resolution: "keep_b",
        resolved_by: "auto",
        resolved_at: new Date().toISOString(),
        metadata: { auto_reason: "newer_supersedes" },
      });

      logger.info("Auto-resolved update conflict", {
        oldId: existing.id.slice(0, 8),
        newId: newFact.id.slice(0, 8),
      });
    }
    return { action: "auto_resolved", existingId: existing.id };
  }

  if (conflictType === "clarification") {
    // Auto-merge: combine the information
    await mergeFact(supabase, existing.id, newContent, sourceChannel, similarity);
    return { action: "merged", existingId: existing.id };
  }

  // Contradiction → create conflict record for user resolution
  // Insert the new fact with needs_review status
  const { data: newFact } = await supabase
    .from("conversation_facts")
    .insert({
      content: newContent,
      type: newType,
      category: classifyCategory(newContent),
      confidence: 0.6,
      source_channel: sourceChannel,
      extraction_method: "pattern" as ExtractionMethod,
      status: "needs_review",
      tags: inferTags(newContent),
    })
    .select("id")
    .single();

  if (newFact) {
    await supabase.from("memory_conflicts").insert({
      fact_a_id: existing.id,
      fact_b_id: newFact.id,
      similarity,
      conflict_type: "contradiction",
      status: "open",
    });

    stats.conflictCount++;
    logger.info("Contradiction detected", {
      factA: existing.id.slice(0, 8),
      factB: newFact.id.slice(0, 8),
      similarity,
    });
  }
  return { action: "conflict_created", existingId: existing.id };
}

/**
 * Classify conflict type by analyzing content relationship.
 * Uses heuristics — no AI call needed for most cases.
 */
function classifyConflictType(
  existingContent: string,
  newContent: string,
): "update" | "clarification" | "contradiction" {
  const oldLower = existingContent.toLowerCase();
  const newLower = newContent.toLowerCase();

  // Update indicators: "switched to", "now use", "changed to", "no longer"
  if (/\b(switched|changed|moved|now use|no longer|updated|replaced)\b/.test(newLower)) {
    return "update";
  }

  // If new content is much longer, it's likely adding detail (clarification)
  if (newContent.length > existingContent.length * 1.5) {
    return "clarification";
  }

  // If both are short and cover the same topic with different values → contradiction
  // Extract the "value" part by removing common words
  const oldWords = new Set(oldLower.split(/\s+/).filter(w => w.length > 3));
  const newWords = new Set(newLower.split(/\s+/).filter(w => w.length > 3));
  const overlap = [...oldWords].filter(w => newWords.has(w)).length;
  const totalUnique = new Set([...oldWords, ...newWords]).size;

  // High word overlap but not identical → likely update or contradiction
  if (totalUnique > 0 && overlap / totalUnique > 0.5 && overlap / totalUnique < 0.9) {
    // Check for negation patterns
    const hasNegation = /\b(not|don'?t|never|no|can'?t|won'?t)\b/.test(newLower) !==
                        /\b(not|don'?t|never|no|can'?t|won'?t)\b/.test(oldLower);
    if (hasNegation) return "contradiction";
    return "update";
  }

  // Default: if content is different enough, it's a clarification (additional info)
  return "clarification";
}

// ── Stats refresh ─────────────────────────────────────────────

async function refreshStats(supabase: SupabaseClient): Promise<void> {
  const [factResult, goalResult, conflictResult, overdueResult] = await Promise.allSettled([
    supabase
      .from("conversation_facts")
      .select("*", { count: "exact", head: true })
      .eq("status", "active")
      .in("type", ["fact", "preference", "decision", "constraint", "contact"]),

    supabase
      .from("conversation_facts")
      .select("*", { count: "exact", head: true })
      .eq("type", "goal")
      .eq("status", "active"),

    supabase
      .from("memory_conflicts")
      .select("*", { count: "exact", head: true })
      .eq("status", "open"),

    supabase
      .from("conversation_facts")
      .select("*", { count: "exact", head: true })
      .eq("type", "goal")
      .eq("status", "active")
      .not("deadline", "is", null)
      .lte("deadline", new Date().toISOString()),
  ]);

  if (factResult.status === "fulfilled") stats.factCount = factResult.value.count ?? 0;
  if (goalResult.status === "fulfilled") stats.goalCount = goalResult.value.count ?? 0;
  if (conflictResult.status === "fulfilled") stats.conflictCount = conflictResult.value.count ?? 0;
  if (overdueResult.status === "fulfilled") stats.overdueGoals = overdueResult.value.count ?? 0;
}

// ── Forest sync ───────────────────────────────────────────────

/**
 * Sync high-confidence facts to Forest for long-term memory.
 * Only syncs facts that haven't been synced yet and have confidence >= threshold.
 */
async function syncToForest(supabase: SupabaseClient): Promise<void> {
  const { data: unsyncedFacts, error } = await supabase
    .from("conversation_facts")
    .select("id, content, type, category, confidence, tags")
    .eq("status", "active")
    .is("forest_memory_id", null)
    .gte("confidence", FOREST_SYNC_THRESHOLD)
    .in("type", ["fact", "preference", "decision", "constraint"])
    .order("created_at", { ascending: true })
    .limit(10);

  if (error || !unsyncedFacts || unsyncedFacts.length === 0) return;

  try {
    const { writeMemory } = await import("../../../ellie-forest/src/index");

    let synced = 0;
    for (const fact of unsyncedFacts) {
      try {
        const forestType = fact.type === "preference" ? "preference"
          : fact.type === "decision" ? "decision"
          : "fact";

        const memory = await writeMemory({
          content: fact.content,
          type: forestType,
          scope_path: "2/1", // ellie-dev scope
          confidence: fact.confidence,
          tags: [...(fact.tags || []), "conversation-fact", fact.category || "other"],
          metadata: {
            source: "memory-module",
            conversation_fact_id: fact.id,
          },
        });

        await supabase
          .from("conversation_facts")
          .update({
            forest_memory_id: memory.id,
            forest_synced_at: new Date().toISOString(),
          })
          .eq("id", fact.id);

        synced++;
      } catch (err) {
        logger.warn("Forest sync failed for fact", { factId: fact.id, err });
      }
    }

    if (synced > 0) {
      logger.info("Forest sync completed", { synced, total: unsyncedFacts.length });
    }
  } catch {
    // Forest unavailable — skip
  }
}

// ── Phase 2: Smart goal tracking ──────────────────────────────

/**
 * Detect implicit goal completion from conversational phrases.
 * Matches against active goals and auto-completes if match is strong.
 */
async function detectGoalCompletion(supabase: SupabaseClient, text: string): Promise<void> {
  const lower = text.toLowerCase();

  // Completion phrases
  const completionPatterns = [
    /\b(?:finished|completed|shipped|launched|deployed|released|done with|wrapped up|closed out)\s+(.+?)(?:\.|!|$)/i,
    /\b(?:finally got|just pushed|merged the|submitted the)\s+(.+?)(?:\.|!|$)/i,
  ];

  for (const pattern of completionPatterns) {
    const match = text.match(pattern);
    if (!match) continue;

    const topic = match[1].trim().slice(0, 100);
    if (topic.length < 5) continue;

    // Search active goals for a match
    const { data: goals } = await supabase
      .from("conversation_facts")
      .select("id, content")
      .eq("type", "goal")
      .eq("status", "active")
      .limit(50);

    if (!goals || goals.length === 0) continue;

    // Find the best matching goal by word overlap
    const topicWords = new Set(topic.toLowerCase().split(/\s+/).filter(w => w.length > 3));
    let bestGoal: { id: string; content: string } | null = null;
    let bestScore = 0;

    for (const goal of goals) {
      const goalWords = new Set(goal.content.toLowerCase().split(/\s+/).filter(w => w.length > 3));
      if (goalWords.size === 0) continue;

      const overlap = [...topicWords].filter(w => goalWords.has(w)).length;
      const score = overlap / Math.max(topicWords.size, goalWords.size);

      if (score > bestScore && score >= 0.4) {
        bestScore = score;
        bestGoal = goal;
      }
    }

    if (bestGoal && bestScore >= 0.4) {
      await supabase
        .from("conversation_facts")
        .update({
          type: "completed_goal",
          status: "archived",
          completed_at: new Date().toISOString(),
          metadata: {
            completion_detected: true,
            completion_phrase: match[0].slice(0, 200),
            match_score: bestScore,
          },
        })
        .eq("id", bestGoal.id);

      stats.goalCount = Math.max(0, stats.goalCount - 1);
      logger.info("Smart goal completion detected", {
        goalId: bestGoal.id.slice(0, 8),
        content: bestGoal.content.slice(0, 60),
        matchScore: bestScore,
      });
    }
  }
}

// ── Phase 2: Health scoring ───────────────────────────────────

/**
 * Compute memory health metrics.
 * Runs periodically to give an overview of fact store quality.
 */
async function computeHealthScore(supabase: SupabaseClient): Promise<void> {
  const [activeResult, staleResult, conflictResult, tagResult, syncResult, confResult] =
    await Promise.allSettled([
      // Total active facts
      supabase
        .from("conversation_facts")
        .select("*", { count: "exact", head: true })
        .eq("status", "active"),

      // Stale facts (not updated in STALE_FACT_DAYS days)
      supabase
        .from("conversation_facts")
        .select("*", { count: "exact", head: true })
        .eq("status", "active")
        .lte("updated_at", new Date(Date.now() - STALE_FACT_DAYS * 24 * 60 * 60 * 1000).toISOString()),

      // Open conflicts
      supabase
        .from("memory_conflicts")
        .select("*", { count: "exact", head: true })
        .eq("status", "open"),

      // Facts with tags (for tag coverage)
      supabase
        .from("conversation_facts")
        .select("*", { count: "exact", head: true })
        .eq("status", "active")
        .not("tags", "eq", "{}"),

      // Facts eligible for Forest sync that ARE synced
      supabase
        .from("conversation_facts")
        .select("forest_memory_id, confidence", { count: "exact" })
        .eq("status", "active")
        .gte("confidence", FOREST_SYNC_THRESHOLD)
        .in("type", ["fact", "preference", "decision", "constraint"]),

      // Average confidence
      supabase
        .from("conversation_facts")
        .select("confidence")
        .eq("status", "active")
        .limit(500),
    ]);

  const totalActive = activeResult.status === "fulfilled" ? (activeResult.value.count ?? 0) : 0;
  const staleCount = staleResult.status === "fulfilled" ? (staleResult.value.count ?? 0) : 0;
  const openConflicts = conflictResult.status === "fulfilled" ? (conflictResult.value.count ?? 0) : 0;
  const taggedCount = tagResult.status === "fulfilled" ? (tagResult.value.count ?? 0) : 0;

  // Forest sync rate
  let forestSyncRate = 0;
  if (syncResult.status === "fulfilled" && syncResult.value.data) {
    const eligible = syncResult.value.data.length;
    const synced = syncResult.value.data.filter(
      (f: { forest_memory_id: string | null }) => f.forest_memory_id !== null,
    ).length;
    forestSyncRate = eligible > 0 ? synced / eligible : 1;
  }

  // Average confidence
  let avgConfidence = 0;
  if (confResult.status === "fulfilled" && confResult.value.data?.length) {
    const confidences = confResult.value.data.map(
      (f: { confidence: number }) => f.confidence,
    );
    avgConfidence = confidences.reduce((sum: number, c: number) => sum + c, 0) / confidences.length;
  }

  stats.health = {
    avgConfidence: Math.round(avgConfidence * 100) / 100,
    staleFacts: staleCount,
    conflictRate: totalActive > 0 ? Math.round((openConflicts / totalActive) * 1000) / 1000 : 0,
    tagCoverage: totalActive > 0 ? Math.round((taggedCount / totalActive) * 100) / 100 : 0,
    forestSyncRate: Math.round(forestSyncRate * 100) / 100,
    totalActive,
    lastHealthCheck: new Date().toISOString(),
  };

  logger.info("Memory health computed", stats.health);
}

// ── Phase 2: Cross-channel consolidation ──────────────────────

/**
 * Periodic consolidation pass: find facts that appear across multiple
 * channels but weren't caught during real-time ingestion. Groups by
 * content similarity and merges duplicates.
 */
async function consolidateCrossChannel(supabase: SupabaseClient): Promise<void> {
  // Find recent facts that might have cross-channel duplicates
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data: recentFacts, error } = await supabase
    .from("conversation_facts")
    .select("id, content, type, source_channel, confidence")
    .eq("status", "active")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(50);

  if (error || !recentFacts || recentFacts.length < 2) return;

  // Group by approximate content (first 50 chars normalized)
  const groups = new Map<string, typeof recentFacts>();
  for (const fact of recentFacts) {
    const key = fact.content.toLowerCase().replace(/[^\w\s]/g, "").trim().slice(0, 50);
    if (key.length < 10) continue;
    const group = groups.get(key) || [];
    group.push(fact);
    groups.set(key, group);
  }

  let merged = 0;
  for (const [, group] of groups) {
    if (group.length < 2) continue;

    // Check if facts are from different channels
    const channels = new Set(group.map(f => f.source_channel));
    if (channels.size < 2) continue;

    // Keep the highest confidence fact, merge others into it
    group.sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
    const keeper = group[0];

    for (let i = 1; i < group.length; i++) {
      const dup = group[i];
      await supabase
        .from("conversation_facts")
        .update({ status: "superseded", superseded_by: keeper.id })
        .eq("id", dup.id);
      merged++;
    }

    // Boost keeper confidence for cross-channel corroboration
    const boosted = Math.min(1.0, (keeper.confidence || 0.7) + 0.05 * (group.length - 1));
    await supabase
      .from("conversation_facts")
      .update({
        confidence: boosted,
        metadata: {
          consolidated_from: group.slice(1).map(f => f.id),
          consolidated_channels: [...channels],
          consolidated_at: new Date().toISOString(),
        },
      })
      .eq("id", keeper.id);
  }

  if (merged > 0) {
    logger.info("Cross-channel consolidation", { merged });
    await refreshStats(supabase).catch(() => {});
  }
}

// ── Classifiers ───────────────────────────────────────────────

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

function inferTags(content: string): string[] {
  const tags: string[] = [];
  const lower = content.toLowerCase();

  if (/\b(editor|vim|vscode|ide|emacs|neovim)\b/.test(lower)) tags.push("editor");
  if (/\b(timezone|tz|utc|cst|est|pst)\b/.test(lower)) tags.push("timezone");
  if (/\b(schedule|meeting|calendar|appointment)\b/.test(lower)) tags.push("schedule");
  if (/\b(food|coffee|tea|restaurant|meal|diet)\b/.test(lower)) tags.push("food");
  if (/\b(code|programming|language|framework|library)\b/.test(lower)) tags.push("development");
  if (/\b(communication|email|slack|telegram|chat)\b/.test(lower)) tags.push("communication");

  return tags;
}
