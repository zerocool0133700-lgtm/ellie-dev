/**
 * ES Forest — Context Integration (ELLIE-107)
 *
 * Provides forest-aware context for the relay's prompt assembly.
 * Runs searchForestSafe() only when the user message is forest-relevant,
 * avoiding unnecessary ES queries on unrelated messages.
 *
 * Also starts the sync listener when the relay boots (if configured).
 */

import { searchForestSafe, type ForestSearchOptions } from "./search-forest.ts";
import { startSyncListener, stopSyncListener, getSyncStats } from "./sync-listener.ts";

// ============================================================
// QUERY DETECTION — only search forest for relevant messages
// ============================================================

/**
 * Forest-specific terms that indicate a message may need forest context.
 * Kept as a single regex for performance (runs on every message).
 */
const FOREST_TERMS = /\b(tree|trees|creature|creatures|session|sessions|incident|incidents|branch|branches|commit|commits|trunk|trunks|work.?item|work.?session|dispatch|dispatched|entity|entities|gate|gating|sweep|backfill)\b/i;

/**
 * Work item references like ELLIE-108, EVE-3, etc.
 */
const WORK_ITEM_REF = /\b[A-Z]+-\d+\b/;

/**
 * Phrases that suggest the user is asking about past work or decisions.
 */
const HISTORY_PHRASES = /\b(what did|what happened|last time|previous|earlier|history|past work|recent work|what was|how did|status of|progress on|show me|look up|find the|search for)\b/i;

/**
 * Check if a user message is likely to benefit from forest context.
 */
export function shouldSearchForest(query: string): boolean {
  if (!query || query.length < 3) return false;
  if (FOREST_TERMS.test(query)) return true;
  if (WORK_ITEM_REF.test(query)) return true;
  if (HISTORY_PHRASES.test(query)) return true;
  return false;
}

// ============================================================
// CONTEXT RETRIEVAL
// ============================================================

/**
 * Get forest search context for a user message.
 * Returns empty string if the message isn't forest-relevant,
 * no relevant data is found, or ES is down.
 */
export async function getForestContext(
  query: string,
  options?: { limit?: number; forceSearch?: boolean }
): Promise<string> {
  if (!process.env.ELASTICSEARCH_URL || process.env.ELASTICSEARCH_ENABLED === "false") return "";

  // Skip forest search for messages that aren't forest-relevant
  if (!options?.forceSearch && !shouldSearchForest(query)) return "";

  return searchForestSafe(query, {
    limit: options?.limit ?? 5,
    recencyBoost: true,
  });
}

// ============================================================
// SYNC LIFECYCLE
// ============================================================

/**
 * Initialize ES forest sync if ELASTICSEARCH_URL is set.
 * The sync listener uses Unix socket defaults for Postgres,
 * so DATABASE_URL is not required.
 * Call this once during relay startup.
 */
export async function initForestSync(): Promise<void> {
  if (!process.env.ELASTICSEARCH_URL || process.env.ELASTICSEARCH_ENABLED === "false") {
    console.log("[es-forest] Elasticsearch disabled (ELASTICSEARCH_URL not set or ELASTICSEARCH_ENABLED=false)");
    return;
  }

  await startSyncListener();
}

export { stopSyncListener, getSyncStats };
