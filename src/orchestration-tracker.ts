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

const logger = log.child("orchestration-tracker");

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
    for (const [runId, run] of activeRuns) {
      try {
        if (run.status !== "running") continue;

        const silenceMs = now - run.lastHeartbeat;
        if (silenceMs > STALE_THRESHOLD_MS) {
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
        }
      } catch (err) {
        logger.error("Watchdog check error", { runId: runId.slice(0, 8) }, err);
      }
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
      emitEvent(run.run_id, "failed", run.agent_type, run.work_item_id, {
        reason: "relay_restart",
        dispatched_at: run.dispatched_at,
      });
    }
  } catch (err) {
    logger.error("Recovery failed (non-fatal)", err);
  }
}
