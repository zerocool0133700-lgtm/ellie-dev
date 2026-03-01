/**
 * Orchestration Tracker — ELLIE-349
 *
 * In-memory state for active agent runs. Tracks liveness via heartbeats,
 * detects stale runs via watchdog timer, and recovers orphaned runs on restart.
 *
 * Complements the orchestration-ledger (persistent DB) with fast,
 * low-latency in-memory tracking for real-time status queries.
 */

import { log } from "./logger.ts";
import { emitEvent, getUnterminated } from "./orchestration-ledger.ts";
import type { NotifyContext, NotifyOptions } from "./notification-policy.ts";

const logger = log.child("orchestration-tracker");

// ELLIE-387: Notification callback — set by relay.ts after deps are ready
let _notifyFn: ((ctx: NotifyContext, opts: NotifyOptions) => Promise<void>) | null = null;
let _notifyCtx: NotifyContext | null = null;

export function setWatchdogNotify(fn: typeof _notifyFn, ctx: NotifyContext): void {
  _notifyFn = fn;
  _notifyCtx = ctx;
}

// ── Types ──────────────────────────────────────────────────

export interface RunState {
  runId: string;
  agentType: string;
  workItemId?: string;
  startedAt: number;
  lastHeartbeat: number;
  status: "running" | "stale" | "completed" | "failed";
  pid?: number;
  channel?: string;
  message?: string;
}

// ── In-memory state ────────────────────────────────────────

const activeRuns = new Map<string, RunState>();
let _watchdogTimer: ReturnType<typeof setInterval> | null = null;

const STALE_THRESHOLD_MS = 90_000; // 90s without heartbeat = stale
const WATCHDOG_INTERVAL_MS = 60_000; // check every 60s
const REAPER_THRESHOLD_MS = 300_000; // 5min stale with dead process = reap

// ── Run lifecycle ──────────────────────────────────────────

/** Register a new active run. */
export function startRun(
  runId: string,
  agentType: string,
  workItemId?: string,
  pid?: number,
  meta?: { channel?: string; message?: string },
): void {
  const now = Date.now();
  activeRuns.set(runId, {
    runId,
    agentType,
    workItemId,
    startedAt: now,
    lastHeartbeat: now,
    status: "running",
    pid,
    channel: meta?.channel,
    message: meta?.message,
  });
  logger.info("Run started", { runId: runId.slice(0, 8), agentType, workItemId, pid });
}

/** Update heartbeat timestamp for a run. */
export function heartbeat(runId: string): void {
  const run = activeRuns.get(runId);
  if (run) {
    run.lastHeartbeat = Date.now();
    // If it was marked stale but now heartbeating again, restore running status
    if (run.status === "stale") {
      run.status = "running";
      logger.info("Run recovered from stale", { runId: runId.slice(0, 8) });
    }
  }
}

/** Mark a run as ended and remove from active tracking. */
export function endRun(runId: string, status: "completed" | "failed"): void {
  const run = activeRuns.get(runId);
  if (run) {
    run.status = status;
    activeRuns.delete(runId);
    logger.info("Run ended", { runId: runId.slice(0, 8), status, duration_ms: Date.now() - run.startedAt });
  }
}

/** Update the PID for a run (called after subprocess spawns). */
export function setRunPid(runId: string, pid: number): void {
  const run = activeRuns.get(runId);
  if (run) {
    run.pid = pid;
  }
}

// ── Queries ────────────────────────────────────────────────

/** Get all currently active/stale runs. */
export function getActiveRunStates(): RunState[] {
  return Array.from(activeRuns.values());
}

/** Get a single run's state. */
export function getRunState(runId: string): RunState | null {
  return activeRuns.get(runId) || null;
}

/**
 * ELLIE-371: Check if a work item already has an active run.
 * Returns the active RunState if found, null otherwise.
 * Used for dispatch locking — prevents duplicate dispatches to same ticket.
 */
export function getActiveRunForWorkItem(workItemId: string): RunState | null {
  for (const run of activeRuns.values()) {
    if (run.workItemId === workItemId && (run.status === "running" || run.status === "stale")) {
      return run;
    }
  }
  return null;
}

// ── Kill / Cancel ─────────────────────────────────────────

/**
 * Kill a running agent subprocess. Sends SIGTERM, waits 5s, then SIGKILL.
 * Returns true if the run was found and killed.
 */
export async function killRun(runId: string): Promise<boolean> {
  const run = activeRuns.get(runId);
  if (!run) return false;
  if (!run.pid) {
    logger.warn("Cannot kill run — no PID", { runId: runId.slice(0, 8) });
    // Still mark as ended
    emitEvent(runId, "cancelled", run.agentType, run.workItemId, { reason: "no_pid" });
    endRun(runId, "failed");
    return true;
  }

  try {
    // Check if process is alive
    process.kill(run.pid, 0);
  } catch {
    // Process already dead
    logger.info("Process already exited, cleaning up", { runId: runId.slice(0, 8), pid: run.pid });
    emitEvent(runId, "cancelled", run.agentType, run.workItemId, { reason: "already_dead" });
    endRun(runId, "failed");
    return true;
  }

  logger.info("Killing run — SIGTERM", { runId: runId.slice(0, 8), pid: run.pid });
  try {
    process.kill(run.pid, "SIGTERM");
  } catch (err) {
    logger.error("SIGTERM failed", { runId: runId.slice(0, 8), pid: run.pid }, err);
  }

  // Wait 5s, then SIGKILL if still alive
  await new Promise(resolve => setTimeout(resolve, 5_000));
  try {
    process.kill(run.pid, 0); // check alive
    logger.warn("Process survived SIGTERM — sending SIGKILL", { runId: runId.slice(0, 8), pid: run.pid });
    process.kill(run.pid, "SIGKILL");
  } catch {
    // Already dead — good
  }

  emitEvent(runId, "cancelled", run.agentType, run.workItemId, { reason: "user_cancel", pid: run.pid });
  endRun(runId, "failed");
  return true;
}

// ── Watchdog ───────────────────────────────────────────────

/**
 * Start the watchdog timer. Checks all active runs for staleness.
 * Stale runs (no heartbeat > 90s) are marked and a timeout event is emitted.
 */
export function startWatchdog(): void {
  if (_watchdogTimer) return; // already running

  _watchdogTimer = setInterval(() => {
    const now = Date.now();
    const toReap: string[] = [];

    for (const [runId, run] of activeRuns) {
      try {
        const silenceMs = now - run.lastHeartbeat;

        // Mark running → stale
        if (run.status === "running" && silenceMs > STALE_THRESHOLD_MS) {
          run.status = "stale";
          logger.warn("Run stale — no heartbeat", {
            runId: runId.slice(0, 8),
            agentType: run.agentType,
            workItemId: run.workItemId,
            silence_ms: silenceMs,
          });
          emitEvent(runId, "timeout", run.agentType, run.workItemId, {
            reason: "watchdog_stale",
            silence_ms: silenceMs,
          });
          // ELLIE-387: Proactive notification — run went stale
          if (_notifyFn && _notifyCtx) {
            const staleMin = Math.round(silenceMs / 60_000);
            _notifyFn(_notifyCtx, {
              event: "run_stale",
              workItemId: run.workItemId || runId.slice(0, 8),
              telegramMessage: `⚠️ ${run.agentType} stalled (no heartbeat ${staleMin}min) on ${run.workItemId || "unknown"}`,
              gchatMessage: `${run.agentType} agent stalled — no heartbeat for ${staleMin} minutes on ${run.workItemId || "unknown task"}`,
            }).catch(() => {});
          }
        }

        // ELLIE-376: Reap stale runs with dead processes
        if (run.status === "stale" && silenceMs > REAPER_THRESHOLD_MS) {
          let processAlive = false;
          if (run.pid) {
            try { process.kill(run.pid, 0); processAlive = true; } catch { /* dead */ }
          }
          if (!processAlive) {
            toReap.push(runId);
          }
        }
      } catch (err) {
        logger.error("Watchdog check error", { runId: runId.slice(0, 8) }, err);
      }
    }

    // Reap dead stale runs outside iteration
    for (const runId of toReap) {
      const run = activeRuns.get(runId);
      if (!run) continue;
      logger.warn("Reaping dead stale run", {
        runId: runId.slice(0, 8),
        agentType: run.agentType,
        workItemId: run.workItemId,
        stale_for_ms: now - run.lastHeartbeat,
        pid: run.pid,
      });
      emitEvent(runId, "failed", run.agentType, run.workItemId, {
        reason: "reaped_dead_process",
        stale_for_ms: now - run.lastHeartbeat,
      });
      // ELLIE-387: Proactive notification — run failed (reaped)
      if (_notifyFn && _notifyCtx) {
        const staleMin = Math.round((now - run.lastHeartbeat) / 60_000);
        _notifyFn(_notifyCtx, {
          event: "run_failed",
          workItemId: run.workItemId || runId.slice(0, 8),
          telegramMessage: `❌ ${run.agentType} failed — process died after ${staleMin}min stall on ${run.workItemId || "unknown"}`,
          gchatMessage: `${run.agentType} agent failed — process died after ${staleMin} minutes stalled on ${run.workItemId || "unknown task"}. Run reaped.`,
        }).catch(() => {});
      }
      endRun(runId, "failed");
    }
  }, WATCHDOG_INTERVAL_MS);

  logger.info("Watchdog started", { interval_ms: WATCHDOG_INTERVAL_MS, threshold_ms: STALE_THRESHOLD_MS });
}

/** Stop the watchdog timer (for relay shutdown). */
export function stopWatchdog(): void {
  if (_watchdogTimer) {
    clearInterval(_watchdogTimer);
    _watchdogTimer = null;
    logger.info("Watchdog stopped");
  }
}

// ── Recovery ───────────────────────────────────────────────

/**
 * On relay startup, find runs that were dispatched but never terminated.
 * These are orphaned (subprocess is gone after restart) — emit failed events.
 */
export async function recoverActiveRuns(): Promise<void> {
  try {
    const unterminated = await getUnterminated();
    if (unterminated.length === 0) {
      logger.info("No orphaned runs to recover");
      return;
    }

    logger.warn(`Recovering ${unterminated.length} orphaned run(s)`);
    for (const run of unterminated) {
      const ageMs = Date.now() - new Date(run.dispatched_at).getTime();
      const ageMin = Math.round(ageMs / 60_000);
      logger.info("Recovering orphaned run", {
        runId: run.run_id.slice(0, 8),
        agentType: run.agent_type,
        workItemId: run.work_item_id,
        dispatched_at: run.dispatched_at,
        age_min: ageMin,
      });
      emitEvent(run.run_id, "failed", run.agent_type, run.work_item_id, {
        reason: "relay_restart",
        dispatched_at: run.dispatched_at,
        orphaned_age_ms: ageMs,
      });
    }
  } catch (err) {
    logger.error("Recovery failed (non-fatal)", err);
  }
}
