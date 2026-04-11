/**
 * ELLIE-1422: Sync conversation_facts → Forest shared_memories
 *
 * Conversation facts (Tier 2 knowledge in Supabase) have forest_synced_at
 * and forest_memory_id columns but no job populates them. This module
 * queries unsynced active facts, writes each to Forest via writeMemory(),
 * and stamps the sync columns so they aren't processed again.
 *
 * Runs as a periodic task (every 6 hours) to populate Tier 3 knowledge.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { log } from "./logger.ts";

const logger = log.child("sync-facts");

/** Map conversation_facts.type → Forest memory type */
function mapFactType(factType: string): string {
  switch (factType) {
    case "fact":
    case "contact":
      return "fact";
    case "preference":
      return "preference";
    case "goal":
    case "completed_goal":
      return "fact";
    case "decision":
      return "decision";
    case "constraint":
      return "fact";
    default:
      return "finding";
  }
}

/** Map conversation_facts.category → Forest scope_path */
function mapCategoryToScope(category: string | null): string {
  // Default to Projects root scope; personal facts are user-scoped
  switch (category) {
    case "technical":
      return "2/1";   // ellie-dev
    case "work":
      return "2";     // Projects
    case "personal":
    case "people":
    case "schedule":
      return "2";     // Projects root — personal knowledge
    default:
      return "2";
  }
}

interface ConversationFact {
  id: string;
  content: string;
  type: string;
  category: string | null;
  confidence: number;
  tags: string[];
  source_channel: string | null;
}

export async function syncConversationFactsToForest(
  supabase: SupabaseClient,
): Promise<{ synced: number; failed: number }> {
  // Fetch unsynced active facts (batch of 25 to avoid overwhelming Forest)
  const { data: facts, error } = await supabase
    .from("conversation_facts")
    .select("id, content, type, category, confidence, tags, source_channel")
    .eq("status", "active")
    .is("forest_memory_id", null)
    .order("created_at", { ascending: true })
    .limit(25);

  if (error) {
    logger.error("Failed to query unsynced facts", { error: error.message });
    return { synced: 0, failed: 0 };
  }

  if (!facts || facts.length === 0) {
    return { synced: 0, failed: 0 };
  }

  const { writeMemory } = await import("../../ellie-forest/src/index.ts");

  let synced = 0;
  let failed = 0;

  for (const fact of facts as ConversationFact[]) {
    try {
      const memory = await writeMemory({
        content: fact.content,
        type: mapFactType(fact.type) as "fact" | "preference" | "decision" | "finding",
        category: fact.category || undefined,
        confidence: fact.confidence,
        tags: [
          "conversation_fact",
          ...(fact.tags || []),
          ...(fact.source_channel ? [`channel:${fact.source_channel}`] : []),
        ],
        metadata: {
          source: "conversation_facts",
          conversation_fact_id: fact.id,
          original_type: fact.type,
          category: fact.category,
        },
      });

      // Index into ES for context builder
      try {
        const { indexMemory, classifyDomain } = await import("./elasticsearch.ts");
        await indexMemory({
          id: memory.id,
          content: fact.content,
          type: mapFactType(fact.type),
          domain: classifyDomain(fact.content),
          created_at: fact.created_at || new Date().toISOString(),
          scope_path: memory.scope_path ?? undefined,
          metadata: { source: 'shared_memories', scope_path: mapCategoryToScope(fact.category) },
        });
      } catch { /* ES indexing is non-fatal */ }

      // Stamp sync columns
      await supabase
        .from("conversation_facts")
        .update({
          forest_memory_id: memory.id,
          forest_synced_at: new Date().toISOString(),
        })
        .eq("id", fact.id);

      synced++;
    } catch (err) {
      logger.warn("Failed to sync fact to Forest", {
        factId: fact.id,
        error: err instanceof Error ? err.message : String(err),
      });
      failed++;
    }
  }

  if (synced > 0 || failed > 0) {
    logger.info("Conversation facts sync complete", { synced, failed, total: facts.length });
  }

  return { synced, failed };
}
