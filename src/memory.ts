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
import { indexMemory, classifyDomain } from "./elasticsearch.ts";

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

// ────────────────────────────────────────────────────────────────
// Conflict Detection
// ────────────────────────────────────────────────────────────────

/**
 * Check if a near-duplicate memory already exists.
 * Uses the search Edge Function to generate an embedding and find
 * similar memories via the match_memory RPC.
 *
 * Returns the best match above the similarity threshold, or null.
 */
export async function checkMemoryConflict(
  supabase: SupabaseClient,
  content: string,
  type: string,
  threshold: number = DEDUP_SIMILARITY_THRESHOLD,
): Promise<SimilarMemory | null> {
  try {
    const { data, error } = await supabase.functions.invoke("search", {
      body: {
        query: content,
        table: "memory",
        match_count: 3,
        match_threshold: threshold,
      },
    });

    if (error || !data?.length) return null;

    // Filter to same type and find best match
    const sameType = data.filter((m: any) => m.type === type);
    if (sameType.length === 0) return null;

    const best = sameType[0];
    return {
      id: best.id,
      content: best.content,
      type: best.type,
      source_agent: best.source_agent || "general",
      visibility: best.visibility || "shared",
      metadata: best.metadata || {},
      similarity: best.similarity,
    };
  } catch (err) {
    // Search Edge Function unavailable — skip dedup, allow insert
    console.warn("[memory] Conflict check unavailable:", err);
    return null;
  }
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

interface MemoryInsertResult {
  id: string | null;
  action: "inserted" | "merged" | "flagged" | "error";
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
  const existing = await checkMemoryConflict(
    supabase, params.content, params.type,
  );

  // No conflict — standard insert
  if (!existing) {
    return await doInsert(supabase, params);
  }

  // 2. Resolve conflict
  const resolution = resolveMemoryConflict(
    existing, params.content, params.source_agent, params.visibility,
  );

  console.log(
    `[memory] Dedup: ${resolution.resolution} for "${params.content.substring(0, 60)}..." — ${resolution.reason}`,
  );

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
    console.error("[memory] Insert failed:", error);
    return { id: null, action: "error", resolution };
  }

  indexMemory({
    id: data.id,
    content: params.content,
    type: params.type,
    domain: classifyDomain(params.content),
    created_at: new Date().toISOString(),
    ...(params.conversation_id ? { conversation_id: params.conversation_id } : {}),
  }).catch(() => {});

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
    console.error("[memory] Merge update failed:", error);
    // Fallback to regular insert
    return await doInsert(supabase, params, resolution);
  }

  console.log(
    `[memory] Merged into existing memory ${existing.id.slice(0, 8)}: ` +
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
    console.error("[memory] Flag update failed:", error);
    // Fallback to regular insert
    return await doInsert(supabase, params, resolution);
  }

  console.log(
    `[memory] Flagged memory ${existing.id.slice(0, 8)} for review: ${resolution.reason}`,
  );

  return { id: existing.id, action: "flagged", resolution };
}

/**
 * Parse Claude's response for memory intent tags.
 * Saves facts/goals to Supabase and returns the cleaned response.
 */
export async function processMemoryIntents(
  supabase: SupabaseClient | null,
  response: string,
  sourceAgent: string = "general",
  defaultVisibility: "private" | "shared" | "global" = "shared",
  forestSessionIds?: { tree_id: string; branch_id?: string; creature_id?: string; entity_id?: string },
): Promise<string> {
  if (!supabase) return response;

  let clean = response;

  // [REMEMBER: fact to store] - uses default visibility
  for (const match of response.matchAll(/\[REMEMBER:\s*(.+?)\]/gi)) {
    await insertMemoryWithDedup(supabase, {
      type: "fact",
      content: match[1],
      source_agent: sourceAgent,
      visibility: defaultVisibility,
    });
    clean = clean.replace(match[0], "");
  }

  // [REMEMBER-PRIVATE: fact to store] - explicit private visibility
  for (const match of response.matchAll(/\[REMEMBER-PRIVATE:\s*(.+?)\]/gi)) {
    await insertMemoryWithDedup(supabase, {
      type: "fact",
      content: match[1],
      source_agent: sourceAgent,
      visibility: "private",
    });
    clean = clean.replace(match[0], "");
  }

  // [REMEMBER-GLOBAL: fact to store] - explicit global visibility
  for (const match of response.matchAll(/\[REMEMBER-GLOBAL:\s*(.+?)\]/gi)) {
    await insertMemoryWithDedup(supabase, {
      type: "fact",
      content: match[1],
      source_agent: sourceAgent,
      visibility: "global",
    });
    clean = clean.replace(match[0], "");
  }

  // [GOAL: text] or [GOAL: text | DEADLINE: date]
  for (const match of response.matchAll(
    /\[GOAL:\s*(.+?)(?:\s*\|\s*DEADLINE:\s*(.+?))?\]/gi
  )) {
    await insertMemoryWithDedup(supabase, {
      type: "goal",
      content: match[1],
      source_agent: sourceAgent,
      visibility: defaultVisibility,
      deadline: match[2] || null,
    });
    clean = clean.replace(match[0], "");
  }

  // [DONE: search text for completed goal]
  for (const match of response.matchAll(/\[DONE:\s*(.+?)\]/gi)) {
    // Build query to find matching goal
    let query = supabase
      .from("memory")
      .select("id")
      .eq("type", "goal")
      .ilike("content", `%${match[1]}%`);

    // Filter by source_agent if available to avoid closing other agents' goals
    if (sourceAgent) {
      query = query.eq("source_agent", sourceAgent);
    }

    const { data } = await query.limit(1);

    if (data?.[0]) {
      await supabase
        .from("memory")
        .update({
          type: "completed_goal",
          completed_at: new Date().toISOString(),
        })
        .eq("id", data[0].id);
    }
    clean = clean.replace(match[0], "");
  }

  // [MEMORY:] tags → forest shared memories
  if (forestSessionIds?.tree_id) {
    console.log(`[memory] Forest session active — tree: ${forestSessionIds.tree_id.slice(0, 8)}, scanning for [MEMORY:] tags`);
    const memoryRegex = /\[MEMORY:(?:(\w+):)?(?:([\d.]+):)?\s*(.+?)\]/gi;
    const memoryMatches = [...response.matchAll(memoryRegex)];
    if (memoryMatches.length === 0) {
      console.log(`[memory] No [MEMORY:] tags found in response (${response.length} chars)`);
    }
    for (const match of memoryMatches) {
      const memType = match[1] || 'finding';
      const confidence = match[2] ? parseFloat(match[2]) : 0.7;
      const content = match[3];
      try {
        const { writeCreatureMemory } = await import('../../ellie-forest/src/index');
        await writeCreatureMemory({
          creature_id: forestSessionIds.creature_id ?? undefined as any,
          tree_id: forestSessionIds.tree_id,
          branch_id: forestSessionIds.branch_id,
          entity_id: forestSessionIds.entity_id,
          content,
          type: memType as any,
          confidence,
        });
        console.log(`[memory] Forest memory: [${memType}:${confidence}] ${content.slice(0, 60)}...`);
      } catch (err) {
        console.warn('[memory] Forest memory write failed:', err);
      }
      clean = clean.replace(match[0], '');
    }
  }

  return clean.trim();
}

/**
 * Get all facts and active goals for prompt context.
 */
export async function getMemoryContext(
  supabase: SupabaseClient | null
): Promise<string> {
  if (!supabase) return "";

  try {
    const [factsResult, goalsResult] = await Promise.all([
      supabase.rpc("get_facts"),
      supabase.rpc("get_active_goals"),
    ]);

    const parts: string[] = [];

    if (factsResult.data?.length) {
      parts.push(
        "FACTS:\n" +
          factsResult.data.map((f: any) => `- ${f.content}`).join("\n")
      );
    }

    if (goalsResult.data?.length) {
      parts.push(
        "GOALS:\n" +
          goalsResult.data
            .map((g: any) => {
              const deadline = g.deadline
                ? ` (by ${new Date(g.deadline).toLocaleDateString()})`
                : "";
              return `- ${g.content}${deadline}`;
            })
            .join("\n")
      );
    }

    return parts.join("\n\n");
  } catch (error) {
    console.error("Memory context error:", error);
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
        .map((m: any) => `[${m.role}]: ${m.content}`)
        .join("\n")
    );
  } catch (error) {
    console.error("Recent messages error:", error);
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
    const { data, error } = await supabase.functions.invoke("search", { body });

    if (error || !data?.length) return "";

    // Filter out results older than 14 days and scope to current channel
    const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
    let recent = data.filter((m: any) => !m.created_at || new Date(m.created_at).getTime() > cutoff);
    if (channel) {
      recent = recent.filter((m: any) => m.channel === channel);
    }
    // ELLIE-202: Exclude messages from current conversation (already loaded in full)
    if (excludeConversationId) {
      recent = recent.filter((m: any) => m.conversation_id !== excludeConversationId);
    }
    recent = recent.slice(0, 3); // Keep top 3
    if (recent.length === 0) return "";

    return (
      "RELEVANT PAST MESSAGES:\n" +
      recent
        .map((m: any) => `[${m.role}]: ${m.content}`)
        .join("\n")
    );
  } catch {
    // Search not available yet (Edge Functions not deployed) — that's fine
    return "";
  }
}
