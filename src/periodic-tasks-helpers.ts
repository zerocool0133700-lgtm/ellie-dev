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
    console.log(`[session-cleanup] Expired ${data.length} stale agent session(s)`);
  }
}
