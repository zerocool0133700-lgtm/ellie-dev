/**
 * Helper functions used by periodic tasks — ELLIE-492
 *
 * Extracted from relay.ts to keep periodic-tasks.ts clean.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { log } from "./logger.ts";

const logger = log.child("tasks");

/** Expire agent sessions that have been active for > 2 hours without activity */
export async function expireStaleAgentSessions(sb: SupabaseClient): Promise<void> {
  const cutoff = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
  const { data, error } = await sb
    .from("agent_sessions")
    .update({ state: "completed", completed_at: new Date().toISOString() })
    .eq("state", "active")
    .lt("last_activity", cutoff)
    .select("id");

  if (error) {
    logger.error("agent_sessions expire error", error);
    return;
  }
  if (data && data.length > 0) {
    logger.info(`Expired ${data.length} stale agent session(s)`);
  }
}

/**
 * ELLIE-936: Graduate high-value Supabase facts to Forest shared_memories.
 * Fix #3: Mark Supabase first (idempotent), then write to Forest.
 * Fix #4: Query only non-graduated facts directly.
 * Fix #20: Structured error logging.
 */
export async function graduateMemories(sb: SupabaseClient): Promise<number> {
  // Fix #4: Fetch facts that haven't been graduated yet
  // Two queries: corroborated facts + high-confidence non-graduated facts
  // ELLIE-1428: Fix PostgREST filter — .not("metadata->>graduated", "eq", "true") returns 0 rows
  // because NULL != 'true' evaluates to NULL (not TRUE) in SQL, so NOT(NULL) = NULL = excluded.
  // Use .or() to correctly match rows where graduated is either null or not 'true'.
  const { data: candidates, error } = await sb
    .from("memory")
    .select("id, content, type, source_agent, visibility, metadata, created_at")
    .eq("type", "fact")
    .or("metadata->>graduated.is.null,metadata->>graduated.neq.true")
    .order("created_at", { ascending: false })
    .limit(50);

  if (error || !candidates?.length) return 0;

  const { writeMemory, readMemories } = await import("../../ellie-forest/src/index.ts");

  let graduated = 0;

  for (const fact of candidates) {
    try {
      // Check for duplicates in Forest via content search
      const existing = await readMemories({
        query: fact.content,
        match_threshold: 0.85,
        match_count: 1,
      });

      if (existing.length > 0 && existing[0].similarity > 0.85) {
        // Already exists in Forest — mark as graduated without creating duplicate
        await sb.from("memory").update({
          metadata: { ...(fact.metadata ?? {}), graduated: true, graduated_at: new Date().toISOString(), forest_match: existing[0].id },
        }).eq("id", fact.id);
        continue;
      }

      // Fix #3: Mark Supabase FIRST as graduating (idempotent flag).
      // If Forest write fails, next run will retry because graduated !== true.
      const graduatingMeta = { ...(fact.metadata ?? {}), graduating: true };
      await sb.from("memory").update({ metadata: graduatingMeta }).eq("id", fact.id);

      // Write to Forest
      await writeMemory({
        content: fact.content,
        type: 'fact',
        confidence: 0.7,
        source_agent_species: fact.source_agent ?? undefined,
        metadata: {
          graduated_from: 'supabase',
          supabase_id: fact.id,
          graduated_at: new Date().toISOString(),
        },
      });

      // Mark as fully graduated in Supabase
      await sb.from("memory").update({
        metadata: { ...(fact.metadata ?? {}), graduated: true, graduated_at: new Date().toISOString() },
      }).eq("id", fact.id);

      graduated++;
    } catch (err: unknown) {
      // Fix #20: Structured error logging
      logger.error("graduation error", {
        fact_id: fact.id,
        content_preview: fact.content?.slice(0, 50),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return graduated;
}
