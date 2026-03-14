/**
 * ELLIE-716: Checkpoint Timer Core
 *
 * Manages time-based progress checkpoints for work sessions.
 * Fires at configurable percentage intervals (default 25/50/75%) of estimated duration.
 *
 * Pure timer logic — no I/O. Side effects (DB writes, notifications) are handled
 * by the callback passed to startCheckpointTimer().
 */

import type {
  CheckpointConfig,
  CheckpointTimerState,
} from "./checkpoint-types.ts";
import {
  DEFAULT_CHECKPOINT_CONFIG,
  DEFAULT_ESTIMATED_DURATION_MINUTES,
} from "./checkpoint-types.ts";
import { log } from "./logger.ts";

const logger = log.child("checkpoint-timer");

// ── Active timers (one per work session) ─────────────────────

const _activeTimers = new Map<string, CheckpointTimerState>();

/** Callback invoked when a checkpoint fires. */
export type CheckpointCallback = (
  sessionId: string,
  workItemId: string,
  agent: string,
  percent: number,
  elapsedMinutes: number,
  estimatedTotalMinutes: number,
) => void | Promise<void>;

// ── Pure calculation functions ────────────────────────────────

/**
 * Calculate the absolute time offset (in ms) for each checkpoint interval.
 * Given intervals [25, 50, 75] and duration 60 min → offsets at 15, 30, 45 min.
 */
export function calculateCheckpointOffsets(
  intervals: number[],
  durationMinutes: number,
): Array<{ percent: number; offsetMs: number }> {
  return intervals
    .filter(p => p > 0 && p < 100)
    .sort((a, b) => a - b)
    .map(percent => ({
      percent,
      offsetMs: Math.round((percent / 100) * durationMinutes * 60 * 1000),
    }));
}

/**
 * Resolve effective checkpoint config from session config + defaults.
 * Returns null if checkpoints are disabled (opt-out).
 */
export function resolveConfig(
  config?: Partial<CheckpointConfig> | null,
): CheckpointConfig | null {
  if (config?.enabled === false) return null;
  const filtered = config?.intervals?.length
    ? config.intervals.filter(n => typeof n === "number" && n > 0 && n < 100)
    : [];
  return {
    enabled: true,
    intervals: filtered.length > 0 ? filtered : DEFAULT_CHECKPOINT_CONFIG.intervals,
  };
}

/**
 * Get elapsed minutes since a start time.
 */
export function getElapsedMinutes(startedAt: Date, now: number = Date.now()): number {
  return Math.round((now - startedAt.getTime()) / 60_000);
}

// ── Timer lifecycle ──────────────────────────────────────────

/**
 * Start checkpoint timers for a work session.
 * Returns the timer state, or null if checkpoints are disabled/opted-out.
 */
export function startCheckpointTimer(
  sessionId: string,
  workItemId: string,
  agent: string,
  estimatedMinutes: number | null | undefined,
  config: Partial<CheckpointConfig> | null | undefined,
  callback: CheckpointCallback,
): CheckpointTimerState | null {
  // Resolve config — null means opted out
  const resolved = resolveConfig(config);
  if (!resolved) {
    logger.info("Checkpoints disabled (opt-out)", { sessionId, workItemId });
    return null;
  }

  // Clean up any existing timer for this session
  stopCheckpointTimer(sessionId);

  const duration = estimatedMinutes ?? DEFAULT_ESTIMATED_DURATION_MINUTES;
  const startedAt = new Date();
  const offsets = calculateCheckpointOffsets(resolved.intervals, duration);

  if (offsets.length === 0) {
    logger.info("No valid checkpoint intervals", { sessionId, workItemId });
    return null;
  }

  const timerIds: ReturnType<typeof setTimeout>[] = [];

  for (const { percent, offsetMs } of offsets) {
    const timerId = setTimeout(async () => {
      const state = _activeTimers.get(sessionId);
      if (!state) return; // session ended before this checkpoint

      const elapsed = getElapsedMinutes(state.started_at);
      state.fired.push(percent);
      state.remaining = state.remaining.filter(p => p !== percent);

      logger.info("Checkpoint fired", {
        sessionId,
        workItemId,
        percent,
        elapsed,
        estimated: duration,
      });

      try {
        await callback(sessionId, workItemId, agent, percent, elapsed, duration);
      } catch (err) {
        logger.error("Checkpoint callback error", {
          sessionId,
          percent,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }, offsetMs);

    timerIds.push(timerId);
  }

  const state: CheckpointTimerState = {
    session_id: sessionId,
    work_item_id: workItemId,
    agent,
    started_at: startedAt,
    estimated_duration_minutes: duration,
    fired: [],
    remaining: offsets.map(o => o.percent),
    timer_ids: timerIds,
  };

  _activeTimers.set(sessionId, state);

  logger.info("Checkpoint timer started", {
    sessionId,
    workItemId,
    duration,
    intervals: resolved.intervals,
    offsets: offsets.map(o => `${o.percent}% @ ${Math.round(o.offsetMs / 60_000)}min`),
  });

  return state;
}

/**
 * Stop and clean up checkpoint timers for a session.
 * Call this when a session ends, completes, or is cancelled.
 * Returns true if a timer was found and stopped.
 */
export function stopCheckpointTimer(sessionId: string): boolean {
  const state = _activeTimers.get(sessionId);
  if (!state) return false;

  for (const id of state.timer_ids) {
    clearTimeout(id);
  }

  _activeTimers.delete(sessionId);

  logger.info("Checkpoint timer stopped", {
    sessionId,
    work_item_id: state.work_item_id,
    fired: state.fired,
    remaining: state.remaining,
  });

  return true;
}

/**
 * Get the timer state for a session (if active).
 */
export function getCheckpointTimerState(sessionId: string): CheckpointTimerState | null {
  return _activeTimers.get(sessionId) ?? null;
}

/**
 * Get all active checkpoint timer session IDs.
 */
export function getActiveCheckpointSessions(): string[] {
  return Array.from(_activeTimers.keys());
}

/**
 * Stop all active checkpoint timers. Used on relay shutdown.
 */
export function stopAllCheckpointTimers(): number {
  let count = 0;
  for (const sessionId of _activeTimers.keys()) {
    stopCheckpointTimer(sessionId);
    count++;
  }
  return count;
}

// ── Test-only exports ────────────────────────────────────────

export const _testing = {
  _activeTimers,
  clearAllTimers: () => {
    for (const state of _activeTimers.values()) {
      for (const id of state.timer_ids) clearTimeout(id);
    }
    _activeTimers.clear();
  },
};
