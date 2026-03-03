/**
 * Stable periodic task runner — ELLIE-458/465
 *
 * Features:
 *   - Startup grace gate (15 s) — skips runs during cold init
 *   - Exponential backoff on failure (5 s → 20 min cap)
 *   - Re-entrancy guard — if a run is still executing the next tick is skipped
 *   - Recovery path — permanently-disabled tasks retry after `recoveryMs` (default 10 min)
 */

import { log } from "./logger.ts";

const logger = log.child("periodic");

export const _startedAt = Date.now();
export const STARTUP_GRACE_MS = 15_000;

export interface PeriodicTaskOpts {
  /** How long after permanent-disable to attempt recovery. Default: 10 min. */
  recoveryMs?: number;
}

export function periodicTask(
  fn: () => Promise<void>,
  intervalMs: number,
  label: string,
  opts: PeriodicTaskOpts = {},
): void {
  const RECOVERY_MS = opts.recoveryMs ?? 10 * 60_000;
  let consecutiveFailures = 0;
  let skipUntil = 0;
  let running = false;   // re-entrancy guard
  let disabledAt = 0;    // when the task was permanently disabled

  setInterval(async () => {
    if (Date.now() - _startedAt < STARTUP_GRACE_MS) return; // startup gate
    if (Date.now() < skipUntil) return;                      // backoff skip
    if (running) return;                                      // re-entrancy guard

    if (consecutiveFailures >= 3) {
      // Recovery path: try again after RECOVERY_MS
      if (disabledAt && Date.now() - disabledAt > RECOVERY_MS) {
        consecutiveFailures = 0;
        skipUntil = 0;
        disabledAt = 0;
        logger.info(`[periodic:${label}] Recovery attempt after ${Math.round(RECOVERY_MS / 60_000)}min`);
      } else {
        return;
      }
    }

    running = true;
    try {
      await fn();
      consecutiveFailures = 0;
      skipUntil = 0;
    } catch (err) {
      consecutiveFailures++;
      const backoffMs = Math.min(5_000 * Math.pow(2, consecutiveFailures - 1), 20 * 60_000);
      skipUntil = Date.now() + backoffMs;
      const msg = err instanceof Error ? err.message : String(err);
      if (consecutiveFailures >= 3) {
        disabledAt = Date.now();
        logger.error(`[periodic:${label}] Disabled after 3 consecutive failures — recovery in ${Math.round(RECOVERY_MS / 60_000)}min`, { error: msg });
      } else {
        logger.warn(`[periodic:${label}] Failure ${consecutiveFailures}/3, backoff ${Math.round(backoffMs / 1000)}s`, { error: msg });
      }
    } finally {
      running = false;
    }
  }, intervalMs);
}
