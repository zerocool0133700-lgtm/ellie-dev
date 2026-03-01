/**
 * Orchestration State Reconciler — ELLIE-393
 *
 * Syncs orchestration state across three sources:
 *   1. In-memory tracker (orchestration-tracker.ts)
 *   2. Forest DB ledger (orchestration_events table)
 *   3. Supabase agent_sessions (active sessions)
 *
 * Runs reconciliation:
 *   - At startup (after recovery)
 *   - Periodically every 60s
 *
 * Logs discrepancies as warnings rather than auto-correcting,
 * except for clearly orphaned in-memory runs with dead processes.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { log } from "./logger.ts";
import { getActiveRunStates, endRun, type RunState } from "./orchestration-tracker.ts";
import { getUnterminated, emitEvent } from "./orchestration-ledger.ts";

const logger = log.child("orchestration-reconciler");

const RECONCILE_INTERVAL_MS = 60_000; // 60s
let _reconcileTimer: ReturnType<typeof setInterval> | null = null;
let _supabase: SupabaseClient | null = null;

// ── Stats (exposed for /debug endpoint) ─────────────────────

export interface ReconcileStats {
  lastRunAt: number | null;
  totalRuns: number;
  discrepanciesFound: number;
  orphansReaped: number;
}

const stats: ReconcileStats = {
  lastRunAt: null,
  totalRuns: 0,
  discrepanciesFound: 0,
  orphansReaped: 0,
};

export function getReconcileStats(): ReconcileStats {
  return { ...stats };
}

// ── Startup Reconciliation ──────────────────────────────────

/**
 * Run full reconciliation at startup.
 * Compares all three data sources and logs discrepancies.
 */
export async function reconcileOnStartup(supabase: SupabaseClient | null): Promise<void> {
  _supabase = supabase;

  try {
    const results = await reconcile("startup");
    if (results.discrepancies > 0) {
      logger.warn("Startup reconciliation found discrepancies", {
        discrepancies: results.discrepancies,
        details: results.details,
      });
    } else {
      logger.info("Startup reconciliation clean — no discrepancies");
    }
  } catch (err) {
    logger.error("Startup reconciliation failed (non-fatal)", err);
  }
}

// ── Periodic Reconciliation ─────────────────────────────────

export function startReconciler(supabase: SupabaseClient | null): void {
  _supabase = supabase;
  if (_reconcileTimer) return;

  _reconcileTimer = setInterval(async () => {
    try {
      await reconcile("periodic");
    } catch (err) {
      logger.error("Periodic reconciliation failed", err);
    }
  }, RECONCILE_INTERVAL_MS);

  logger.info("Reconciler started", { interval_ms: RECONCILE_INTERVAL_MS });
}

export function stopReconciler(): void {
  if (_reconcileTimer) {
    clearInterval(_reconcileTimer);
    _reconcileTimer = null;
    logger.info("Reconciler stopped");
  }
}

// ── Core Reconciliation Logic ───────────────────────────────

interface ReconcileResult {
  discrepancies: number;
  details: string[];
}

async function reconcile(trigger: "startup" | "periodic"): Promise<ReconcileResult> {
  const details: string[] = [];
  let discrepancies = 0;

  // 1. Get in-memory runs
  const memoryRuns = getActiveRunStates();
  const memoryRunIds = new Set(memoryRuns.map(r => r.runId));

  // 2. Get Forest DB unterminated runs
  let forestRuns: Array<{ run_id: string; agent_type: string | null; work_item_id: string | null; dispatched_at: string }> = [];
  try {
    forestRuns = await getUnterminated();
  } catch (err) {
    logger.warn("Could not query Forest ledger for reconciliation", err);
  }
  const forestRunIds = new Set(forestRuns.map(r => r.run_id));

  // 3. Get Supabase active sessions (if available)
  let supabaseActiveSessions: Array<{ id: string; agent_id: string; state: string; work_item_id: string | null }> = [];
  if (_supabase) {
    try {
      const { data } = await _supabase
        .from("agent_sessions")
        .select("id, agent_id, state, work_item_id")
        .eq("state", "active")
        .order("last_activity", { ascending: false })
        .limit(50);
      supabaseActiveSessions = data || [];
    } catch (err) {
      logger.warn("Could not query Supabase sessions for reconciliation", err);
    }
  }

  // ── Check 1: In-memory runs missing from Forest ──
  // If a run is in memory but Forest has no "dispatched" event, something went wrong
  for (const run of memoryRuns) {
    if (!forestRunIds.has(run.runId)) {
      discrepancies++;
      details.push(`memory-only: run ${run.runId.slice(0, 8)} (${run.agentType}) — in memory but not in Forest ledger`);
    }
  }

  // ── Check 2: Forest unterminated runs missing from memory ──
  // After startup recovery, there should be no unterminated Forest runs
  // that aren't in memory. If there are, the process that was running
  // them is gone.
  for (const fRun of forestRuns) {
    if (!memoryRunIds.has(fRun.run_id)) {
      discrepancies++;
      const ageMs = Date.now() - new Date(fRun.dispatched_at).getTime();
      const ageMin = Math.round(ageMs / 60_000);
      details.push(`forest-orphan: run ${fRun.run_id.slice(0, 8)} (${fRun.agent_type}) — dispatched ${ageMin}min ago, not tracked in memory`);

      // Auto-fix: emit failed event for orphaned Forest runs
      if (trigger === "startup") {
        emitEvent(fRun.run_id, "failed", fRun.agent_type, fRun.work_item_id, {
          reason: "reconciler_orphan",
          trigger,
          age_ms: ageMs,
        });
        stats.orphansReaped++;
        logger.warn("Reconciler reaped forest orphan", {
          runId: fRun.run_id.slice(0, 8),
          agentType: fRun.agent_type,
          ageMin,
        });
      }
    }
  }

  // ── Check 3: In-memory runs with dead processes ──
  for (const run of memoryRuns) {
    if (run.pid) {
      let alive = false;
      try { process.kill(run.pid, 0); alive = true; } catch { /* dead */ }
      if (!alive && run.status === "running") {
        discrepancies++;
        details.push(`dead-process: run ${run.runId.slice(0, 8)} (${run.agentType}) pid=${run.pid} — process dead but status=running`);

        // Auto-fix: mark as failed
        emitEvent(run.runId, "failed", run.agentType, run.workItemId || null, {
          reason: "reconciler_dead_process",
          trigger,
          pid: run.pid,
        });
        endRun(run.runId, "failed");
        stats.orphansReaped++;
        logger.warn("Reconciler reaped dead-process run", {
          runId: run.runId.slice(0, 8),
          pid: run.pid,
        });
      }
    }
  }

  // ── Check 4: Long-running Supabase sessions with no matching in-memory run ──
  // This is informational only — active sessions may be from interactive chat,
  // not orchestrated runs. Just log for visibility.
  if (supabaseActiveSessions.length > 20) {
    details.push(`supabase: ${supabaseActiveSessions.length} active sessions — may indicate session leak`);
    discrepancies++;
  }

  // Update stats
  stats.lastRunAt = Date.now();
  stats.totalRuns++;
  stats.discrepanciesFound += discrepancies;

  if (discrepancies > 0 && trigger === "periodic") {
    logger.warn("Reconciliation found discrepancies", {
      trigger,
      discrepancies,
      memoryRuns: memoryRuns.length,
      forestUnterminated: forestRuns.length,
      supabaseSessions: supabaseActiveSessions.length,
    });
  }

  return { discrepancies, details };
}
