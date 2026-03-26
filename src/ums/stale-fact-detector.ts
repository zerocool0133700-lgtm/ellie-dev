/**
 * Stale Fact Detection — ELLIE-1036
 * Age-based confidence decay and contradiction detection.
 * Inspired by Keeper.sh stale mapping detection pattern.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { log } from "../logger.ts";

const logger = log.child("ums:stale");

const DECAY_RATE_PER_30_DAYS = 0.1; // Lose 0.1 confidence per 30 days
const MIN_CONFIDENCE = 0.1; // Floor — never goes below this
const STALE_THRESHOLD_DAYS = 90; // Facts older than this are candidates for archival

/**
 * Calculate decayed confidence based on age.
 */
export function calculateDecayedConfidence(originalConfidence: number, ageMs: number): number {
  const ageDays = ageMs / (24 * 60 * 60_000);
  const periods = Math.floor(ageDays / 30);
  const decayed = originalConfidence - (periods * DECAY_RATE_PER_30_DAYS);
  return Math.max(MIN_CONFIDENCE, Math.round(decayed * 100) / 100);
}

/**
 * Run staleness scoring on all active facts.
 * Returns count of facts updated.
 */
export async function scoreFactStaleness(supabase: SupabaseClient): Promise<{
  updated: number;
  stale: number;
  archived: number;
}> {
  const now = Date.now();
  let updated = 0;
  let stale = 0;
  let archived = 0;

  // Fetch active facts older than 30 days
  const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60_000).toISOString();
  const { data: facts, error } = await supabase
    .from("conversation_facts")
    .select("id, confidence, created_at, updated_at")
    .eq("status", "active")
    .lt("created_at", thirtyDaysAgo)
    .order("created_at", { ascending: true })
    .limit(500);

  if (error || !facts) {
    logger.error("Failed to fetch facts for staleness scoring", error);
    return { updated: 0, stale: 0, archived: 0 };
  }

  for (const fact of facts) {
    const ageMs = now - new Date(fact.created_at).getTime();
    const decayed = calculateDecayedConfidence(fact.confidence, ageMs);
    const ageDays = ageMs / (24 * 60 * 60_000);

    if (decayed !== fact.confidence) {
      // Update confidence
      await supabase
        .from("conversation_facts")
        .update({ confidence: decayed, updated_at: new Date().toISOString() })
        .eq("id", fact.id);
      updated++;
    }

    if (ageDays >= STALE_THRESHOLD_DAYS && decayed <= MIN_CONFIDENCE) {
      // Archive very old, very low-confidence facts
      await supabase
        .from("conversation_facts")
        .update({
          status: "archived",
          archived_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", fact.id);
      archived++;
    } else if (decayed < 0.3) {
      stale++;
    }
  }

  logger.info("Staleness scoring complete", { updated, stale, archived, scanned: facts.length });
  return { updated, stale, archived };
}

// Export for testing
export { DECAY_RATE_PER_30_DAYS, MIN_CONFIDENCE, STALE_THRESHOLD_DAYS };
