/**
 * ES Forest — Context Integration (ELLIE-113)
 *
 * Provides forest-aware context for the relay's prompt assembly.
 * Runs searchForestSafe() and formats results for injection
 * alongside existing context sources.
 *
 * Also starts the sync listener when the relay boots (if configured).
 */

import { searchForestSafe, type ForestSearchOptions } from "./search-forest.ts";
import { startSyncListener, stopSyncListener, getSyncStats } from "./sync-listener.ts";

/**
 * Get forest search context for a user message.
 * Returns empty string if no relevant forest data found or ES is down.
 */
export async function getForestContext(
  query: string,
  options?: { limit?: number }
): Promise<string> {
  if (!process.env.ELASTICSEARCH_URL) return "";

  return searchForestSafe(query, {
    limit: options?.limit ?? 5,
    recencyBoost: true,
  });
}

/**
 * Initialize ES forest sync if both DATABASE_URL and ELASTICSEARCH_URL are set.
 * Call this once during relay startup.
 */
export async function initForestSync(): Promise<void> {
  if (!process.env.ELASTICSEARCH_URL) {
    console.log("[es-forest] ELASTICSEARCH_URL not set, forest ES disabled");
    return;
  }
  if (!process.env.DATABASE_URL) {
    console.log("[es-forest] DATABASE_URL not set, sync listener disabled (search still works)");
    return;
  }

  await startSyncListener();
}

export { stopSyncListener, getSyncStats };
