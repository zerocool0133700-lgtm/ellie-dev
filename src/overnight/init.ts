/**
 * Overnight Scheduler — Relay Init Hook (ELLIE-1148)
 *
 * Called during relay startup to:
 * 1. Recover interrupted overnight sessions (mark as stopped)
 * 2. Reset module state so the scheduler is available for new sessions
 *
 * Called during relay shutdown to:
 * 1. Stop any running overnight session gracefully
 */

import { log } from "../logger.ts";
import { isOvernightRunning, stopOvernightSession } from "./scheduler.ts";
import { cleanupOrphanedContainers } from "./docker-executor.ts";
import type { SupabaseClient } from "@supabase/supabase-js";

const logger = log.child("overnight-init");

export interface OvernightInitResult {
  recoveredSessions: number;
  cleanedContainers: number;
}

/**
 * Initialize the overnight scheduler subsystem.
 * Marks any sessions left in "running" state (from a prior crash) as stopped.
 */
export async function initOvernight(supabase: SupabaseClient | null): Promise<OvernightInitResult> {
  // ELLIE-1163: Clean up orphaned Docker containers from prior relay instances
  let cleanedContainers = 0;
  try {
    cleanedContainers = await cleanupOrphanedContainers();
    if (cleanedContainers > 0) {
      logger.info("Cleaned up orphaned overnight containers", { count: cleanedContainers });
    }
  } catch (err) {
    logger.warn("Orphaned container cleanup failed (non-fatal)", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  if (!supabase) {
    logger.info("Supabase not available — overnight init skipped");
    return { recoveredSessions: 0, cleanedContainers };
  }

  // Find sessions stuck in "running" from a prior relay instance
  const { data: stale, error } = await supabase
    .from("overnight_sessions")
    .select("id")
    .eq("status", "running");

  if (error) {
    logger.warn("Failed to query stale overnight sessions", { error: error.message });
    return { recoveredSessions: 0, cleanedContainers };
  }

  if (!stale || stale.length === 0) {
    logger.info("No interrupted overnight sessions found");
    return { recoveredSessions: 0, cleanedContainers };
  }

  // Mark each stale session as stopped
  for (const session of stale) {
    const { error: updateErr } = await supabase
      .from("overnight_sessions")
      .update({
        status: "stopped",
        stop_reason: "relay_restart",
        stopped_at: new Date().toISOString(),
      })
      .eq("id", session.id);

    if (updateErr) {
      logger.warn("Failed to recover session", { sessionId: session.id, error: updateErr.message });
    }
  }

  logger.info("Recovered interrupted overnight sessions", { count: stale.length });
  return { recoveredSessions: stale.length, cleanedContainers };
}

/**
 * Gracefully shut down the overnight scheduler.
 * Stops any running session so the DB record is clean.
 */
export async function shutdownOvernight(): Promise<void> {
  if (isOvernightRunning()) {
    logger.info("Stopping active overnight session for relay shutdown");
    try {
      await stopOvernightSession("manual");
    } catch (err) {
      logger.warn("Overnight shutdown stop failed (non-fatal)", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
