/**
 * Stable periodic task runner — ELLIE-458/465/467
 *
 * Features:
 *   - Startup grace gate (15 s) — skips runs during cold init
 *   - Exponential backoff on failure (5 s → 20 min cap)
 *   - Re-entrancy guard — if a run is still executing the next tick is skipped
 *   - Recovery path — permanently-disabled tasks retry after `recoveryMs` (default 10 min)
 *   - Jitter — random delay ±10% of intervalMs spreads startup/steady-state load (ELLIE-467)
 *   - Max recovery attempts — prevents infinite retry on permanent failures (ELLIE-467)
 */

import { log } from "./logger.ts";

const logger = log.child("periodic");

export const _startedAt = Date.now();
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

export function periodicTask(
  fn: () => Promise<void>,
  intervalMs: number,
  label: string,
  opts: PeriodicTaskOpts = {},
): void {
  const RECOVERY_MS = opts.recoveryMs ?? 10 * 60_000;
  const JITTER_MS = opts.jitterMs ?? Math.floor(intervalMs * 0.1);
  const MAX_RECOVERIES = opts.maxRecoveries ?? 0; // 0 = unlimited
  let consecutiveFailures = 0;
  let skipUntil = 0;
  let running = false;
  let disabledAt = 0;
  let recoveryAttempts = 0;

  const schedule = (delayMs: number) => setTimeout(tick, delayMs);
  const jitteredInterval = () => intervalMs + Math.floor(Math.random() * JITTER_MS);

  const tick = async () => {
    // Startup grace — relay is still initialising, don't fire yet
    if (Date.now() - _startedAt < STARTUP_GRACE_MS) {
      schedule(jitteredInterval());
      return;
    }

    // Backoff wait — task failed recently, respect skipUntil
    if (Date.now() < skipUntil) {
      schedule(skipUntil - Date.now() + Math.floor(Math.random() * 1_000));
      return;
    }

    // Re-entrancy guard — previous run still executing
    if (running) {
      schedule(jitteredInterval());
      return;
    }

    // Permanent-disable path with optional recovery
    if (consecutiveFailures >= 3) {
      if (MAX_RECOVERIES > 0 && recoveryAttempts >= MAX_RECOVERIES) {
        // Exhausted all recovery attempts — stop permanently
        logger.error(`[periodic:${label}] Permanently stopped after ${recoveryAttempts} recovery cycles`);
        return; // no reschedule
      }
      if (disabledAt && Date.now() - disabledAt > RECOVERY_MS) {
        recoveryAttempts++;
        consecutiveFailures = 0;
        skipUntil = 0;
        disabledAt = 0;
        logger.info(`[periodic:${label}] Recovery attempt ${MAX_RECOVERIES ? `${recoveryAttempts}/${MAX_RECOVERIES}` : recoveryAttempts} after ${Math.round(RECOVERY_MS / 60_000)}min`);
      } else {
        schedule(jitteredInterval());
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

    schedule(jitteredInterval());
  };

  // Spread startup load: each task fires after a random initial delay within the jitter window
  schedule(Math.floor(Math.random() * JITTER_MS));
}
