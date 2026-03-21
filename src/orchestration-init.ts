/**
 * Orchestration Initialization — ELLIE-563
 *
 * Extracted from relay.ts so the orchestration startup sequence is testable.
 * Failure of any step rejects the promise — the caller (relay.ts) must treat
 * this as a critical failure and exit the process.
 *
 * Steps (in order):
 *   1. recoverActiveRuns  — resurrect any runs that were active before restart
 *   2. cleanupOrphanedJobs — mark leaked jobs as failed
 *   3. reconcileOnStartup — sync orchestration state with Supabase
 *   4. startWatchdog      — periodic heartbeat checks for stuck runs
 *   5. startReconciler    — periodic state reconciliation
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { startWatchdog, recoverActiveRuns } from "./orchestration-tracker.ts";
import { reconcileOnStartup, startReconciler } from "./orchestration-reconciler.ts";
import { cleanupOrphanedJobs } from "./jobs-ledger.ts";
import { recoverSpawnRegistry } from "./session-spawn.ts";
import { log } from "./logger.ts";

const logger = log.child("orchestration-init");

/**
 * Run the full orchestration startup sequence.
 * Throws on any failure — caller is responsible for aborting the process.
 */
export async function initOrchestration(supabase: SupabaseClient | null): Promise<{
  recoveredRuns: void;
  orphanedJobs: number;
}> {
  logger.info("Starting orchestration initialization");

  // Step 1: Recover active runs from previous session
  await recoverActiveRuns();

  // Step 1b: ELLIE-954 — Recover spawn registry from DB
  const spawnRecovery = await recoverSpawnRegistry().catch((err) => {
    logger.warn("Spawn registry recovery failed (non-fatal)", { err: err instanceof Error ? err.message : String(err) });
    return { recovered: 0, staleMarked: 0 };
  });

  // Step 2: Cleanup orphaned jobs
  const orphanCount = await cleanupOrphanedJobs();
  if (orphanCount > 0) {
    logger.info(`Cleaned up ${orphanCount} orphaned job(s)`);
  }

  // Step 3: Reconcile with Supabase
  await reconcileOnStartup(supabase);

  // Step 4 & 5: Start background monitors
  startWatchdog();
  startReconciler(supabase);

  logger.info("Orchestration initialization complete");

  return { recoveredRuns: undefined, orphanedJobs: orphanCount, spawnRecovery };
}
