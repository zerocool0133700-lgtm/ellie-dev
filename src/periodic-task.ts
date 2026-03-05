/**
 * Unified periodic task runner — ELLIE-458/465/467/487/492
 *
 * Features:
 *   - TaskRegistry: central registry with start/stop/status for all tasks (ELLIE-492)
 *   - Startup grace gate (15 s) — skips runs during cold init
 *   - Exponential backoff on failure (5 s → 20 min cap)
 *   - Re-entrancy guard — if a run is still executing the next tick is skipped
 *   - Recovery path — permanently-disabled tasks retry after `recoveryMs` (default 10 min)
 *   - Jitter — random delay ±10% of intervalMs spreads startup/steady-state load (ELLIE-467)
 *   - Max recovery attempts — prevents infinite retry on permanent failures (ELLIE-467)
 *   - stopAllTasks() cancels all timers on shutdown (ELLIE-487/492)
 *   - getTaskStatus() for /health endpoint visibility (ELLIE-492)
 */

import { log } from "./logger.ts";

const logger = log.child("periodic");

export let _startedAt = Date.now();
export const STARTUP_GRACE_MS = 15_000;

export interface PeriodicTaskOpts {
  /** How long after permanent-disable to attempt recovery. Default: 10 min. */
  recoveryMs?: number;
  /** Max random jitter added to each interval. Default: 10% of intervalMs. */
  jitterMs?: number;
  /**
   * Max number of recovery cycles before the task is permanently stopped.
   * Default: unlimited (0). Each recovery cycle = one round of up to 3 failures.
   */
  maxRecoveries?: number;
}

// ── Task status types ────────────────────────────────────────

export interface TaskStatus {
  label: string;
  intervalMs: number;
  state: "running" | "idle" | "backoff" | "disabled" | "stopped";
  lastRunAt: number | null;
  consecutiveFailures: number;
  recoveryAttempts: number;
}

interface RegisteredTask {
  label: string;
  intervalMs: number;
  timer: ReturnType<typeof setTimeout> | null;
  running: boolean;
  consecutiveFailures: number;
  skipUntil: number;
  disabledAt: number;
  recoveryAttempts: number;
  lastRunAt: number | null;
  stopped: boolean;
}

// ── Global task registry ─────────────────────────────────────

const _tasks = new Map<string, RegisteredTask>();

/** Get status of all registered periodic tasks — for /health endpoint */
export function getTaskStatus(): TaskStatus[] {
  return Array.from(_tasks.values()).map(t => ({
    label: t.label,
    intervalMs: t.intervalMs,
    state: t.stopped ? "stopped"
      : t.consecutiveFailures >= 3 ? "disabled"
      : t.running ? "running"
      : t.skipUntil > Date.now() ? "backoff"
      : "idle",
    lastRunAt: t.lastRunAt,
    consecutiveFailures: t.consecutiveFailures,
    recoveryAttempts: t.recoveryAttempts,
  }));
}

/** Stop all periodic tasks and clear their timers. Once called, no task will fire again. */
export function stopAllTasks(): void {
  for (const task of _tasks.values()) {
    task.stopped = true;
    if (task.timer) {
      clearTimeout(task.timer);
      task.timer = null;
    }
  }
  logger.info(`[periodic] Stopped all ${_tasks.size} task(s)`);
}

// Back-compat alias used by ELLIE-487 graceful shutdown
export const stopAllPeriodicTasks = stopAllTasks;

// ── Test utilities ────────────────────────────────────────────

/**
 * Override the module start time — for unit tests only.
 * Set to `Date.now() - STARTUP_GRACE_MS - 1000` to bypass the startup grace check.
 */
export function _setStartedAtForTesting(t: number): void {
  _startedAt = t;
}

/**
 * Stop all tasks and clear the registry — for unit tests only.
 * Call in beforeEach to ensure test isolation.
 */
export function _resetTasksForTesting(): void {
  stopAllTasks();
  _tasks.clear();
}

// ── Register + run a periodic task ───────────────────────────

export function periodicTask(
  fn: () => Promise<void>,
  intervalMs: number,
  label: string,
  opts: PeriodicTaskOpts = {},
): void {
  const RECOVERY_MS = opts.recoveryMs ?? 10 * 60_000;
  const JITTER_MS = opts.jitterMs ?? Math.floor(intervalMs * 0.1);
  const MAX_RECOVERIES = opts.maxRecoveries ?? 0; // 0 = unlimited

  const task: RegisteredTask = {
    label,
    intervalMs,
    timer: null,
    running: false,
    consecutiveFailures: 0,
    skipUntil: 0,
    disabledAt: 0,
    recoveryAttempts: 0,
    lastRunAt: null,
    stopped: false,
  };

  _tasks.set(label, task);

  const schedule = (delayMs: number) => {
    if (task.stopped) return;
    task.timer = setTimeout(tick, delayMs);
  };
  const jitteredInterval = () => intervalMs + Math.floor(Math.random() * JITTER_MS);

  const tick = async () => {
    if (task.stopped) return;

    // Startup grace — relay is still initialising, don't fire yet
    if (Date.now() - _startedAt < STARTUP_GRACE_MS) {
      schedule(jitteredInterval());
      return;
    }

    // Backoff wait — task failed recently, respect skipUntil
    if (Date.now() < task.skipUntil) {
      schedule(task.skipUntil - Date.now() + Math.floor(Math.random() * 1_000));
      return;
    }

    // Re-entrancy guard — previous run still executing
    if (task.running) {
      schedule(jitteredInterval());
      return;
    }

    // Permanent-disable path with optional recovery
    if (task.consecutiveFailures >= 3) {
      if (MAX_RECOVERIES > 0 && task.recoveryAttempts >= MAX_RECOVERIES) {
        logger.error(`[periodic:${label}] Permanently stopped after ${task.recoveryAttempts} recovery cycles`);
        task.stopped = true;
        return;
      }
      if (task.disabledAt && Date.now() - task.disabledAt > RECOVERY_MS) {
        task.recoveryAttempts++;
        task.consecutiveFailures = 0;
        task.skipUntil = 0;
        task.disabledAt = 0;
        logger.info(`[periodic:${label}] Recovery attempt ${MAX_RECOVERIES ? `${task.recoveryAttempts}/${MAX_RECOVERIES}` : task.recoveryAttempts} after ${Math.round(RECOVERY_MS / 60_000)}min`);
      } else {
        schedule(jitteredInterval());
        return;
      }
    }

    task.running = true;
    try {
      await fn();
      task.consecutiveFailures = 0;
      task.skipUntil = 0;
      task.lastRunAt = Date.now();
    } catch (err) {
      task.consecutiveFailures++;
      const backoffMs = Math.min(5_000 * Math.pow(2, task.consecutiveFailures - 1), 20 * 60_000);
      task.skipUntil = Date.now() + backoffMs;
      const msg = err instanceof Error ? err.message : String(err);
      if (task.consecutiveFailures >= 3) {
        task.disabledAt = Date.now();
        logger.error(`[periodic:${label}] Disabled after 3 consecutive failures — recovery in ${Math.round(RECOVERY_MS / 60_000)}min`, { error: msg });
      } else {
        logger.warn(`[periodic:${label}] Failure ${task.consecutiveFailures}/3, backoff ${Math.round(backoffMs / 1000)}s`, { error: msg });
      }
    } finally {
      task.running = false;
    }

    schedule(jitteredInterval());
  };

  // Spread startup load: each task fires after a random initial delay within the jitter window
  schedule(Math.floor(Math.random() * JITTER_MS));
}
