/**
 * Memory Module
 *
 * Persistent facts, goals, and preferences stored in Supabase.
 * Claude manages memory automatically via intent tags in its responses:
 *   [REMEMBER: fact]
 *   [GOAL: text | DEADLINE: date]
 *   [DONE: search text]
 *
 * The relay parses these tags, saves to Supabase, and strips them
 * from the response before sending to the user.
 *
 * ELLIE-71: Conflict resolution via cosine similarity dedup.
 * Before inserting a memory, we check for near-duplicates using the
 * search Edge Function (similarity > 0.85). Resolution strategies:
 *   - merge:         Update existing memory's metadata with alt_sources
 *   - keep_both:     Insert as new (different enough semantically)
 *   - flag_for_user: Mark existing memory for human review
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "crypto";
import { indexMemory, classifyDomain } from "./elasticsearch.ts";
import { resilientTask } from "./resilient-task.ts";
import { log } from "./logger.ts";
import { breakers } from "./resilience.ts";

const logger = log.child("memory");

// ────────────────────────────────────────────────────────────────
// ELLIE-1425: Health metrics for search outage monitoring
// ────────────────────────────────────────────────────────────────

let _searchOutageCount = 0;
let _lastSearchOutageAt: Date | null = null;

export function recordSearchOutage(): void {
  _searchOutageCount++;
  _lastSearchOutageAt = new Date();
}

export function getSearchOutageMetrics(): { outageCount: number; lastOutageAt: Date | null } {
  return { outageCount: _searchOutageCount, lastOutageAt: _lastSearchOutageAt };
}

export function _resetSearchOutageMetricsForTesting(): void {
  _searchOutageCount = 0;
  _lastSearchOutageAt = null;
}

// ────────────────────────────────────────────────────────────────
// Conflict Resolution Types & Constants
// ────────────────────────────────────────────────────────────────

/** Configurable similarity threshold for duplicate detection. */
export const DEDUP_SIMILARITY_THRESHOLD = 0.85;

/** Above this threshold, memories are near-identical and always merged. */
const AUTO_MERGE_THRESHOLD = 0.95;

/** Between DEDUP and AUTO_MERGE, use heuristics to decide. */
const AMBIGUOUS_UPPER = AUTO_MERGE_THRESHOLD;
const AMBIGUOUS_LOWER = DEDUP_SIMILARITY_THRESHOLD;

export type ConflictResolution = "merge" | "keep_both" | "flag_for_user";

export interface SimilarMemory {
  id: string;
  content: string;
  type: string;
  source_agent: string;
  visibility: string;
  metadata: Record<string, unknown>;
  similarity: number;
}

export interface ConflictResult {
  resolution: ConflictResolution;
  existingMemory: SimilarMemory | null;
  reason: string;
}

/**
 * ELLIE-481: Distinguishes "no conflict" from "search unavailable".
 * Callers must not treat unavailability as "no conflict" — they should queue instead.
 */
export type ConflictCheckResult =
  | { available: true; match: SimilarMemory | null }
  | { available: false };

/** Shape of a row returned by the search Edge Function for messages. */
interface SearchMessageResult {
  role: string;
  content: string;
  created_at?: string;
  channel?: string;
  conversation_id?: string;
  similarity?: number;
}

/** Shape of a row returned by the search Edge Function for memory. */
interface SearchMemoryResult {
  id: string;
  content: string;
  type: string;
  source_agent?: string;
  visibility?: string;
  metadata?: Record<string, unknown>;
  similarity: number;
}

/** Shape of a fact row returned by the get_facts RPC. */
interface FactRow {
  content: string;
}

/** Shape of a goal row returned by the get_active_goals RPC. */
interface GoalRow {
  content: string;
  deadline?: string | null;
}

/** Shape of a message row returned by the messages query. */
interface MessageRow {
  role: string;
  content: string;
  created_at: string;
}

// ────────────────────────────────────────────────────────────────
// Conflict Detection
// ────────────────────────────────────────────────────────────────

/**
 * Check if a near-duplicate memory already exists.
 * Uses the search Edge Function to generate an embedding and find
 * similar memories via the match_memory RPC.
 *
 * ELLIE-481: Returns ConflictCheckResult instead of SimilarMemory | null.
 * When search is unavailable (circuit breaker open or Edge Function error),
 * returns { available: false } so callers can queue instead of silently inserting.
 */
export async function checkMemoryConflict(
  supabase: SupabaseClient,
  content: string,
  type: string,
  threshold: number = DEDUP_SIMILARITY_THRESHOLD,
): Promise<ConflictCheckResult> {
  // ELLIE-484: circuit breaker — throw on error so failures are recorded
  const invoked = await breakers.edgeFn.call(
    async () => {
      const r = await supabase.functions.invoke("search", {
        body: { query: content, table: "memory", match_count: 3, match_threshold: threshold },
      });
      if (r.error) throw r.error;
      return r;
    },
    null,
  );

  if (!invoked) {
    logger.warn("Memory dedup search unavailable — circuit breaker blocked or Edge Function errored");
    recordSearchOutage();
    return { available: false };
  }

  if (!invoked.data?.length) return { available: true, match: null };
  const data = invoked.data;

  // Filter to same type and find best match
  const sameType = data.filter((m: SearchMemoryResult) => m.type === type);
  if (sameType.length === 0) return { available: true, match: null };

  const best = sameType[0];
  return {
    available: true,
    match: {
      id: best.id,
      content: best.content,
      type: best.type,
      source_agent: best.source_agent || "general",
      visibility: best.visibility || "shared",
      metadata: best.metadata || {},
      similarity: best.similarity,
    },
  };
}

// ────────────────────────────────────────────────────────────────
// Conflict Resolution Logic
// ────────────────────────────────────────────────────────────────

/**
 * Determine how to resolve a memory conflict.
 *
 * Strategy:
 *   - similarity >= 0.95 (AUTO_MERGE): Always merge — near-identical content.
 *   - similarity 0.85-0.95 (AMBIGUOUS):
 *       - Same agent: merge (agent re-learned the same thing)
 *       - Different agent, same visibility: merge + track alt_sources
 *       - Different agent, different visibility: keep_both (access scoping matters)
 *       - Content is significantly longer/shorter: flag_for_user (may be update vs. new)
 *   - similarity < 0.85: keep_both (below threshold — different enough)
 */
export function resolveMemoryConflict(
  existing: SimilarMemory,
  newContent: string,
  newSourceAgent: string,
  newVisibility: string,
): ConflictResult {
  const similarity = existing.similarity;

  // Below threshold — shouldn't happen but guard against it
  if (similarity < AMBIGUOUS_LOWER) {
    return {
      resolution: "keep_both",
      existingMemory: existing,
      reason: `Similarity ${similarity.toFixed(3)} below threshold ${AMBIGUOUS_LOWER}`,
    };
  }

  // Near-identical (>= 0.95) — always merge
  if (similarity >= AMBIGUOUS_UPPER) {
    return {
      resolution: "merge",
      existingMemory: existing,
      reason: `Near-identical (similarity ${similarity.toFixed(3)} >= ${AMBIGUOUS_UPPER})`,
    };
  }

  // Ambiguous zone (0.85 - 0.95): apply heuristics

  // Same agent re-learning the same thing — merge
  if (existing.source_agent === newSourceAgent) {
    return {
      resolution: "merge",
      existingMemory: existing,
      reason: `Same agent "${newSourceAgent}" with similarity ${similarity.toFixed(3)} — likely re-learned`,
    };
  }

  // Different agent, different visibility — keep both (access scoping matters)
  if (existing.visibility !== newVisibility) {
    return {
      resolution: "keep_both",
      existingMemory: existing,
      reason: `Different visibility (${existing.visibility} vs ${newVisibility}) — access scoping preserved`,
    };
  }

  // Significant length difference (>2x) suggests one is a more detailed version —
  // flag for user review since auto-merge might lose nuance
  const lengthRatio = newContent.length / existing.content.length;
  if (lengthRatio > 2.0 || lengthRatio < 0.5) {
    return {
      resolution: "flag_for_user",
      existingMemory: existing,
      reason: `Length ratio ${lengthRatio.toFixed(1)}x with similarity ${similarity.toFixed(3)} — may be an update vs. new fact`,
    };
  }

  // Default for ambiguous zone with different agents: merge and track sources
  return {
    resolution: "merge",
    existingMemory: existing,
    reason: `Cross-agent corroboration (${existing.source_agent} + ${newSourceAgent}, similarity ${similarity.toFixed(3)})`,
  };
}

// ────────────────────────────────────────────────────────────────
// Dedup-Aware Memory Insert
// ────────────────────────────────────────────────────────────────

export interface MemoryInsertParams {
  type: string;
  content: string;
  source_agent: string;
  visibility: "private" | "shared" | "global";
  deadline?: string | null;
  conversation_id?: string | null;
  metadata?: Record<string, unknown>;
}

// ── ELLIE-481/1419: Pending queue for inserts skipped due to unavailable search ──
// Persisted to Supabase `pending_memory_inserts` table so items survive relay restarts.
// In-memory shadow for sync health checks and test compatibility.
const _testPendingQueue: MemoryInsertParams[] = [];

/** Compute idempotency key for a memory insert (SHA-256 of type+content+source_agent). */
function pendingIdempotencyKey(params: MemoryInsertParams): string {
  return createHash("sha256")
    .update(`${params.type}|${params.content}|${params.source_agent}`)
    .digest("hex");
}

/** Enqueue a memory insert to the persistent pending table. */
async function enqueuePendingInsert(supabase: SupabaseClient, params: MemoryInsertParams): Promise<void> {
  const key = pendingIdempotencyKey(params);
  // Best-effort persist to Supabase; also track in-memory for sync health checks
  try {
    await supabase.from("pending_memory_inserts").upsert({
      idempotency_key: key,
      type: params.type,
      content: params.content,
      source_agent: params.source_agent,
      visibility: params.visibility,
      deadline: params.deadline || null,
      conversation_id: params.conversation_id || null,
      metadata: params.metadata || {},
    }, { onConflict: "idempotency_key" });
  } catch {
    // Supabase may also be down — fall through, item is tracked in-memory below
  }
  _testPendingQueue.push(params);
}

/** Returns pending inserts from the durable queue (for health/diagnostics). */
export async function getPendingMemoryQueue(supabase: SupabaseClient): Promise<MemoryInsertParams[]> {
  const { data } = await supabase
    .from("pending_memory_inserts")
    .select("type, content, source_agent, visibility, deadline, conversation_id, metadata")
    .order("created_at", { ascending: true });
  return (data || []) as MemoryInsertParams[];
}

/**
 * Flush all pending memory inserts — called on startup and periodically.
 * Re-runs each through insertMemoryWithDedup; items that succeed are deleted,
 * items that fail again stay in the table with incremented attempt count.
 */
export async function flushPendingMemoryInserts(supabase: SupabaseClient): Promise<{ flushed: number; remaining: number }> {
  const { data: pending } = await supabase
    .from("pending_memory_inserts")
    .select("*")
    .lt("attempts", 10)
    .order("created_at", { ascending: true })
    .limit(50);

  if (!pending || pending.length === 0) {
    _testPendingQueue.length = 0;
    return { flushed: 0, remaining: 0 };
  }

  let flushed = 0;
  let remaining = 0;

  for (const item of pending) {
    try {
      const result = await insertMemoryWithDedup(supabase, {
        type: item.type,
        content: item.content,
        source_agent: item.source_agent,
        visibility: item.visibility,
        deadline: item.deadline,
        conversation_id: item.conversation_id,
        metadata: item.metadata,
      });

      if (result.action === "queued") {
        // Search still unavailable — bump attempt count but leave in table
        await supabase
          .from("pending_memory_inserts")
          .update({ attempts: item.attempts + 1, last_attempt_at: new Date().toISOString() })
          .eq("id", item.id);
        remaining++;
      } else {
        // Successfully processed — remove from queue
        await supabase.from("pending_memory_inserts").delete().eq("id", item.id);
        flushed++;
      }
    } catch (err) {
      await supabase
        .from("pending_memory_inserts")
        .update({
          attempts: item.attempts + 1,
          last_attempt_at: new Date().toISOString(),
          error_message: err instanceof Error ? err.message : String(err),
        })
        .eq("id", item.id);
      remaining++;
    }
  }

  // Sync in-memory shadow
  if (flushed > 0) _testPendingQueue.length = remaining;

  if (flushed > 0 || remaining > 0) {
    logger.info("Pending memory flush", { flushed, remaining });
  }
  return { flushed, remaining };
}

interface MemoryInsertResult {
  id: string | null;
  action: "inserted" | "merged" | "flagged" | "error" | "queued";
  resolution?: ConflictResult;
}

/**
 * Insert a memory with dedup conflict resolution.
 *
 * Flow:
 * 1. Check for near-duplicate via search Edge Function
 * 2. If match found, resolve conflict (merge / keep_both / flag_for_user)
 * 3. Execute the resolution:
 *    - merge: Update existing row's metadata with alt_sources, skip insert
 *    - keep_both: Insert as new row
 *    - flag_for_user: Update existing row's metadata with needs_review flag, skip insert
 * 4. Index in Elasticsearch
 *
 * Returns the row ID (existing or new) and the action taken.
 */
export async function insertMemoryWithDedup(
  supabase: SupabaseClient,
  params: MemoryInsertParams,
): Promise<MemoryInsertResult> {
  // 1. Check for conflict
  const checkResult = await checkMemoryConflict(
    supabase, params.content, params.type,
  );

  // ELLIE-481/1419: Search unavailable — persist to durable queue for later flush
  if (!checkResult.available) {
    await enqueuePendingInsert(supabase, params);
    logger.warn("Memory dedup search unavailable — queued insert for later flush", {
      content: params.content.substring(0, 60),
    });
    return { id: null, action: "queued" };
  }

  const existing = checkResult.match;

  // No conflict — standard insert
  if (!existing) {
    return await doInsert(supabase, params);
  }

  // 2. Resolve conflict
  const resolution = resolveMemoryConflict(
    existing, params.content, params.source_agent, params.visibility,
  );

  logger.info(`Dedup: ${resolution.resolution} for "${params.content.substring(0, 60)}..." — ${resolution.reason}`);

  // 3. Execute resolution
  switch (resolution.resolution) {
    case "merge":
      return await doMerge(supabase, existing, params, resolution);

    case "flag_for_user":
      return await doFlag(supabase, existing, params, resolution);

    case "keep_both":
    default:
      return await doInsert(supabase, params, resolution);
  }
}

/**
 * Standard insert — no conflict or keep_both resolution.
 */
async function doInsert(
  supabase: SupabaseClient,
  params: MemoryInsertParams,
  resolution?: ConflictResult,
): Promise<MemoryInsertResult> {
  const row: Record<string, unknown> = {
    type: params.type,
    content: params.content,
    source_agent: params.source_agent,
    visibility: params.visibility,
    deadline: params.deadline || null,
  };
  if (params.conversation_id) row.conversation_id = params.conversation_id;
  if (params.metadata) row.metadata = params.metadata;

  const { data, error } = await supabase.from("memory").insert(row).select("id").single();

  if (error || !data?.id) {
    logger.error("Insert failed", error);
    return { id: null, action: "error", resolution };
  }

  // ELLIE-479: resilient fire-and-forget
  resilientTask("indexMemory", "critical", () => indexMemory({
    id: data.id,
    content: params.content,
    type: params.type,
    domain: classifyDomain(params.content),
    created_at: new Date().toISOString(),
    ...(params.conversation_id ? { conversation_id: params.conversation_id } : {}),
  }));

  return { id: data.id, action: "inserted", resolution };
}

/**
 * Merge — update existing memory's metadata to track the new source agent,
 * bump updated_at, and optionally update content if the new version is longer
 * (richer detail).
 */
async function doMerge(
  supabase: SupabaseClient,
  existing: SimilarMemory,
  params: MemoryInsertParams,
  resolution: ConflictResult,
): Promise<MemoryInsertResult> {
  // Build alt_sources array: track which agents corroborated this memory
  const existingAltSources: string[] = Array.isArray(existing.metadata?.alt_sources)
    ? existing.metadata.alt_sources as string[]
    : [];

  // Add the new source agent if not already tracked
  const allSources = new Set([
    existing.source_agent,
    ...existingAltSources,
    params.source_agent,
  ]);

  const updatedMetadata = {
    ...existing.metadata,
    alt_sources: [...allSources].filter((s) => s !== existing.source_agent),
    last_corroborated_at: new Date().toISOString(),
    corroboration_count: (Number(existing.metadata?.corroboration_count) || 0) + 1,
  };

  // If the new content is substantially longer, prefer it (more detail)
  const useNewContent = params.content.length > existing.content.length * 1.3;

  const updatePayload: Record<string, unknown> = {
    metadata: updatedMetadata,
  };

  if (useNewContent) {
    updatePayload.content = params.content;
    // Wipe embedding so the webhook regenerates it for the new content
    updatePayload.embedding = null;
  }

  // Promote visibility if new insert has broader scope
  const visibilityRank = { private: 0, shared: 1, global: 2 } as const;
  if (visibilityRank[params.visibility as keyof typeof visibilityRank] >
      visibilityRank[existing.visibility as keyof typeof visibilityRank]) {
    updatePayload.visibility = params.visibility;
  }

  const { error } = await supabase
    .from("memory")
    .update(updatePayload)
    .eq("id", existing.id);

  if (error) {
    logger.error("Merge update failed", error);
    // Fallback to regular insert
    return await doInsert(supabase, params, resolution);
  }

  logger.info(
    `Merged into existing memory ${existing.id.slice(0, 8)}: ` +
    `${[...allSources].join(", ")} (corroboration #${updatedMetadata.corroboration_count})`,
  );

  return { id: existing.id, action: "merged", resolution };
}

/**
 * Flag for user — mark the existing memory as needing review.
 * The conflict info is stored in metadata for the user to inspect.
 */
async function doFlag(
  supabase: SupabaseClient,
  existing: SimilarMemory,
  params: MemoryInsertParams,
  resolution: ConflictResult,
): Promise<MemoryInsertResult> {
  const updatedMetadata = {
    ...existing.metadata,
    needs_review: true,
    conflict_info: {
      new_content: params.content,
      new_source_agent: params.source_agent,
      new_visibility: params.visibility,
      similarity: existing.similarity,
      reason: resolution.reason,
      flagged_at: new Date().toISOString(),
    },
  };

  const { error } = await supabase
    .from("memory")
    .update({ metadata: updatedMetadata })
    .eq("id", existing.id);

  if (error) {
    logger.error("Flag update failed", error);
    // Fallback to regular insert
    return await doInsert(supabase, params, resolution);
  }

  logger.info(`Flagged memory ${existing.id.slice(0, 8)} for review: ${resolution.reason}`);

  return { id: existing.id, action: "flagged", resolution };
}

// ── ELLIE-481: Search availability + pending queue flush ──────────────────────

/**
 * Returns true when the Edge Function circuit breaker is not open.
 * Use this to gate features that require semantic search.
 */
export function isSearchAvailable(): boolean {
  return breakers.edgeFn.getState().state !== "open";
}

/**
 * Returns current search availability and the number of pending inserts
 * waiting for search to come back.
 */
export function getMemorySearchHealth(): { searchAvailable: boolean; pendingQueueLength: number; outageCount: number; lastOutageAt: Date | null } {
  const outageMetrics = getSearchOutageMetrics();
  return {
    searchAvailable: isSearchAvailable(),
    // ELLIE-1419: Queue is now in Supabase — sync length only available via async getPendingMemoryQueue.
    // This returns 0 as a placeholder; use the async version for accurate counts.
    pendingQueueLength: _testPendingQueue.length,
    ...outageMetrics,
  };
}

/**
 * Returns a user-facing warning when memory search is degraded.
 * Returns null when search is operating normally.
 * ELLIE-1425: Surface search outage to user so they know dedup is paused.
 */
export function getSearchDegradationWarning(): string | null {
  if (isSearchAvailable()) return null;
  const { outageCount } = getSearchOutageMetrics();
  return `⚠️ Memory search is temporarily unavailable (${outageCount} outage${outageCount !== 1 ? 's' : ''} detected). Memory dedup is paused — new memories will be queued and processed when search recovers.`;
}

/** @deprecated Use the async Supabase-backed version. Kept for test compat. */
export function clearPendingMemoryQueue(): void {
  _testPendingQueue.length = 0;
}

/** Sync getter for the in-memory pending queue shadow. Test use only. */
export function getTestPendingQueue(): MemoryInsertParams[] {
  return [..._testPendingQueue];
}

/**
 * Parse Claude's response for memory intent tags.
 * Saves facts/goals to Supabase and returns the cleaned response.
 */
// ELLIE-968: Write [REMEMBER:] facts directly to Forest for immediate prompt availability
async function _writeFactToForest(
  forestSessionIds: { tree_id: string; branch_id?: string; creature_id?: string; entity_id?: string },
  content: string,
  sourceAgent: string,
  type: "fact" | "preference" = "fact",
): Promise<void> {
  const { writeCreatureMemory } = await import("../../ellie-forest/src/index");
  await writeCreatureMemory({
    creature_id: forestSessionIds.creature_id ?? undefined,
    tree_id: forestSessionIds.tree_id,
    branch_id: forestSessionIds.branch_id,
    entity_id: forestSessionIds.entity_id,
    content,
    type,
    confidence: 0.8,
    scope_path: "2",
  });
  logger.info(`[REMEMBER:] → Forest: ${content.slice(0, 60)}...`);
}

/**
 * ELLIE-1421: Parsed intent — intermediate representation before processing.
 * Separates parsing (pure) from processing (side-effectful) so we can
 * batch-process with rollback on failure.
 */
interface ParsedIntent {
  tag: string;                    // full matched tag string to strip from response
  kind: "insert" | "done" | "forest";
  params?: MemoryInsertParams;    // for insert intents
  doneSearch?: string;            // for [DONE:] intents
  forestWrite?: {                 // for [MEMORY:] intents
    type: string;
    confidence: number;
    content: string;
  };
  writeToForest?: boolean;        // for REMEMBER/REMEMBER-GLOBAL → immediate Forest write
}

export async function processMemoryIntents(
  supabase: SupabaseClient | null,
  response: string,
  sourceAgent: string = "general",
  defaultVisibility: "private" | "shared" | "global" = "shared",
  forestSessionIds?: { tree_id: string; branch_id?: string; creature_id?: string; entity_id?: string },
): Promise<string> {
  if (!supabase) return response;

  // ── Phase 1: Parse all intents (pure, no side effects) ────────────

  const intents: ParsedIntent[] = [];

  // [REMEMBER: fact to store]
  for (const match of response.matchAll(/\[REMEMBER:\s*(.+?)\]/gi)) {
    intents.push({
      tag: match[0],
      kind: "insert",
      params: { type: "fact", content: match[1], source_agent: sourceAgent, visibility: defaultVisibility },
      writeToForest: true,
    });
  }

  // [REMEMBER-PRIVATE: fact to store]
  for (const match of response.matchAll(/\[REMEMBER-PRIVATE:\s*(.+?)\]/gi)) {
    intents.push({
      tag: match[0],
      kind: "insert",
      params: { type: "fact", content: match[1], source_agent: sourceAgent, visibility: "private" },
    });
  }

  // [REMEMBER-GLOBAL: fact to store]
  for (const match of response.matchAll(/\[REMEMBER-GLOBAL:\s*(.+?)\]/gi)) {
    intents.push({
      tag: match[0],
      kind: "insert",
      params: { type: "fact", content: match[1], source_agent: sourceAgent, visibility: "global" },
      writeToForest: true,
    });
  }

  // [GOAL: text | DEADLINE: date]
  for (const match of response.matchAll(/\[GOAL:\s*(.+?)(?:\s*\|\s*DEADLINE:\s*(.+?))?\]/gi)) {
    intents.push({
      tag: match[0],
      kind: "insert",
      params: { type: "goal", content: match[1], source_agent: sourceAgent, visibility: defaultVisibility, deadline: match[2] || null },
    });
  }

  // [DONE: search text]
  for (const match of response.matchAll(/\[DONE:\s*(.+?)\]/gi)) {
    intents.push({ tag: match[0], kind: "done", doneSearch: match[1] });
  }

  // [MEMORY:] tags → Forest
  if (forestSessionIds?.tree_id) {
    logger.info(`Forest session active — tree: ${forestSessionIds.tree_id.slice(0, 8)}, scanning for [MEMORY:] tags`);
    const memoryRegex = /\[MEMORY:(?:(\w+):)?(?:([\d.]+):)?\s*(.+?)\]/gi;
    const memoryMatches = [...response.matchAll(memoryRegex)];
    if (memoryMatches.length === 0) {
      logger.info(`No [MEMORY:] tags found in response (${response.length} chars)`);
    }
    for (const match of memoryMatches) {
      intents.push({
        tag: match[0],
        kind: "forest",
        forestWrite: {
          type: match[1] || "finding",
          confidence: match[2] ? parseFloat(match[2]) : 0.7,
          content: match[3],
        },
      });
    }
  }

  // No intents found — return early
  if (intents.length === 0) return response;

  // ── Phase 2: Process all intents with rollback on failure ──────────

  const committedIds: string[] = [];        // IDs of inserted memories (for rollback)
  const completedGoalIds: string[] = [];    // IDs of goals marked done (for rollback)

  try {
    for (const intent of intents) {
      if (intent.kind === "insert" && intent.params) {
        const result = await insertMemoryWithDedup(supabase, intent.params);
        if (result.id) committedIds.push(result.id);

        // ELLIE-968: Write to Forest immediately for REMEMBER/REMEMBER-GLOBAL
        if (intent.writeToForest && forestSessionIds?.tree_id) {
          _writeFactToForest(forestSessionIds, intent.params.content, sourceAgent, "fact").catch(err =>
            logger.warn("Forest fact write failed (non-fatal)", { err: err instanceof Error ? err.message : String(err) })
          );
        }
      } else if (intent.kind === "done" && intent.doneSearch) {
        let query = supabase
          .from("memory")
          .select("id")
          .eq("type", "goal")
          .ilike("content", `%${intent.doneSearch}%`);
        if (sourceAgent) query = query.eq("source_agent", sourceAgent);
        const { data } = await query.limit(1);

        if (data?.[0]) {
          await supabase
            .from("memory")
            .update({ type: "completed_goal", completed_at: new Date().toISOString() })
            .eq("id", data[0].id);
          completedGoalIds.push(data[0].id);
        }
      } else if (intent.kind === "forest" && intent.forestWrite && forestSessionIds?.tree_id) {
        const { type: memType, confidence, content } = intent.forestWrite;
        try {
          const { writeCreatureMemory } = await import('../../ellie-forest/src/index');
          await writeCreatureMemory({
            creature_id: forestSessionIds.creature_id ?? undefined,
            tree_id: forestSessionIds.tree_id,
            branch_id: forestSessionIds.branch_id,
            entity_id: forestSessionIds.entity_id,
            content,
            type: memType as 'fact' | 'decision' | 'preference' | 'finding' | 'hypothesis',
            confidence,
            scope_path: '2/1/2',
          });
          logger.info(`Forest memory: [${memType}:${confidence}] ${content.slice(0, 60)}...`);
        } catch (err) {
          logger.warn("Forest memory write failed", err);
        }
      }
    }
  } catch (err) {
    // ── Rollback: undo committed inserts and goal completions ──
    logger.error("Memory intent processing failed — rolling back", {
      error: err instanceof Error ? err.message : String(err),
      committedIds,
      completedGoalIds,
    });

    for (const id of committedIds) {
      try { await supabase.from("memory").delete().eq("id", id); } catch { /* best-effort */ }
    }
    for (const id of completedGoalIds) {
      try {
        await supabase.from("memory").update({ type: "goal", completed_at: null }).eq("id", id);
      } catch { /* best-effort */ }
    }

    throw err;
  }

  // ── Phase 3: Strip all intent tags from response ──────────────────

  let clean = response;
  for (const intent of intents) {
    clean = clean.replace(intent.tag, "");
  }
  return clean.trim();
}

/**
 * Get all facts and active goals for prompt context.
 */
export async function getMemoryContext(
  supabase: SupabaseClient | null,
  sourceAgent?: string,
): Promise<string> {
  if (!supabase) return "";

  try {
    // ELLIE-1417: Pass requesting agent so RPCs filter private memories
    const rpcParams = sourceAgent ? { requesting_agent: sourceAgent } : {};
    const [factsResult, goalsResult] = await Promise.all([
      supabase.rpc("get_facts", rpcParams),
      supabase.rpc("get_active_goals", rpcParams),
    ]);

    const parts: string[] = [];

    if (factsResult.data?.length) {
      parts.push(
        "FACTS:\n" +
          factsResult.data.map((f: FactRow) => `- ${f.content}`).join("\n")
      );
    }

    if (goalsResult.data?.length) {
      parts.push(
        "GOALS:\n" +
          goalsResult.data
            .map((g: GoalRow) => {
              const deadline = g.deadline
                ? ` (by ${new Date(g.deadline).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: process.env.USER_TIMEZONE || "America/Chicago" })})`
                : "";
              return `- ${g.content}${deadline}`;
            })
            .join("\n")
      );
    }

    return parts.join("\n\n");
  } catch (error) {
    logger.error("Memory context error", error);
    return "";
  }
}

/**
 * Get the most recent messages for conversation continuity.
 * This ensures Claude always has the immediate conversation thread,
 * not just semantically similar messages.
 */
export async function getRecentMessages(
  supabase: SupabaseClient | null,
  limit: number = 10,
  channel?: string,
  userId?: string,
): Promise<string> {
  if (!supabase) return "";

  try {
    let query = supabase
      .from("messages")
      .select("role, content, created_at")
      .order("created_at", { ascending: false })
      .limit(limit);

    if (channel) {
      query = query.eq("channel", channel);
    } else {
      query = query.in("channel", ["telegram", "voice", "google-chat"]);
    }

    if (userId) {
      query = query.eq("user_id", userId);
    }

    const { data, error } = await query;

    if (error || !data?.length) return "";

    // Reverse so oldest is first (chronological order)
    const messages = data.reverse();

    return (
      "RECENT CONVERSATION:\n" +
      messages
        .map((m: MessageRow) => `[${m.role}]: ${m.content}`)
        .join("\n")
    );
  } catch (error) {
    logger.error("Recent messages error", error);
    return "";
  }
}

/**
 * Semantic search for relevant past messages via the search Edge Function.
 * The Edge Function handles embedding generation (OpenAI key stays in Supabase).
 */
export async function getRelevantContext(
  supabase: SupabaseClient | null,
  query: string,
  channel?: string,
  sourceAgent?: string,
  excludeConversationId?: string,
): Promise<string> {
  if (!supabase) return "";
  if (query.trim().length < 10) return ""; // Short messages don't need search context

  try {
    // Request extra results so we still get enough after channel filtering
    const matchCount = channel ? 8 : 3;
    const body: Record<string, unknown> = {
      query, match_count: matchCount, match_threshold: 0.75, table: "messages",
    };
    if (sourceAgent) body.source_agent = sourceAgent;
    // ELLIE-484: circuit breaker — throw on error so failures are recorded
    const invoked = await breakers.edgeFn.call(
      async () => {
        const r = await supabase.functions.invoke("search", { body });
        if (r.error) throw r.error;
        return r;
      },
      null,
    );

    if (!invoked || !invoked.data?.length) return "";
    const data = invoked.data;

    // Filter out results older than 14 days and scope to current channel
    const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
    let recent = data.filter((m: SearchMessageResult) => !m.created_at || new Date(m.created_at).getTime() > cutoff);
    if (channel) {
      recent = recent.filter((m: SearchMessageResult) => m.channel === channel);
    }
    // ELLIE-202: Exclude messages from current conversation (already loaded in full)
    if (excludeConversationId) {
      recent = recent.filter((m: SearchMessageResult) => m.conversation_id !== excludeConversationId);
    }
    recent = recent.slice(0, 3); // Keep top 3
    if (recent.length === 0) return "";

    return (
      "RELEVANT PAST MESSAGES:\n" +
      recent
        .map((m: SearchMessageResult) => `[${m.role}]: ${m.content}`)
        .join("\n")
    );
  } catch {
    // Search not available yet (Edge Functions not deployed) — that's fine
    return "";
  }
}

// ── ELLIE-967: Tier 2 fact retrieval ────────────────────────

/**
 * Retrieve relevant personal facts from the Supabase `memory` table.
 * These are facts stored via [REMEMBER:] tags — personal knowledge about
 * the user, their preferences, goals, and context.
 *
 * Unlike getRelevantContext() which searches messages, this searches the
 * curated memory table for higher-signal, deduplicated knowledge.
 */
export async function getRelevantFacts(
  supabase: SupabaseClient | null,
  query: string,
): Promise<string> {
  if (!supabase) return "";
  if (query.trim().length < 10) return "";

  try {
    const invoked = await breakers.edgeFn.call(
      async () => {
        const r = await supabase.functions.invoke("search", {
          body: { query, table: "memory", match_count: 8, match_threshold: 0.7 },
        });
        if (r.error) throw r.error;
        return r;
      },
      null,
    );

    if (!invoked || !invoked.data?.length) return "";
    const data = invoked.data as SearchMemoryResult[];

    // Filter to active facts/preferences/goals — skip archived or low-relevance
    const facts = data
      .filter((m) => m.type !== "archived" && m.similarity >= 0.7)
      .slice(0, 5);

    if (facts.length === 0) return "";

    return (
      "PERSONAL KNOWLEDGE (remembered facts):\n" +
      facts.map((m) => `- [${m.type}] ${m.content}`).join("\n")
    );
  } catch {
    return "";
  }
}
