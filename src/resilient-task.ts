/**
 * Resilient fire-and-forget task runner — ELLIE-479
 *
 * Wraps async operations that are currently fire-and-forget with:
 *   - Retry with exponential backoff (for critical operations)
 *   - Failure counter/metrics exposed via health endpoint
 *   - Audit trail via structured logging
 *
 * Categories:
 *   - critical: Retry up to 3x with backoff (session sync, queue acks, ES indexing)
 *   - best-effort: No retry, but track failures (corrections, playbooks, assessments)
 *   - cosmetic: No retry, no tracking (cache writes, temp file cleanup)
 */

import { log } from "./logger.ts";

const logger = log.child("resilient");

// ── Types ────────────────────────────────────────────────────

type TaskCategory = "critical" | "best-effort" | "cosmetic";

interface ResilientOpts {
  /** How many times to retry on failure. Default: 3 for critical, 0 for others. */
  maxRetries?: number;
  /** Base delay in ms for exponential backoff. Default: 1000. */
  baseDelayMs?: number;
  /** Max delay cap in ms. Default: 15000. */
  maxDelayMs?: number;
}

interface FailureRecord {
  label: string;
  category: TaskCategory;
  totalFailures: number;
  lastFailure: number | null;
  lastError: string | null;
  totalRetries: number;
  totalSuccesses: number;
}

// ── Global metrics registry ──────────────────────────────────

const _metrics = new Map<string, FailureRecord>();

/** Get metrics for all tracked fire-and-forget operations — for /health endpoint */
export function getFireForgetMetrics(): {
  summary: { totalFailures: number; totalRetries: number; totalSuccesses: number };
  operations: FailureRecord[];
} {
  const ops = Array.from(_metrics.values());
  return {
    summary: {
      totalFailures: ops.reduce((s, o) => s + o.totalFailures, 0),
      totalRetries: ops.reduce((s, o) => s + o.totalRetries, 0),
      totalSuccesses: ops.reduce((s, o) => s + o.totalSuccesses, 0),
    },
    operations: ops.filter(o => o.totalFailures > 0 || o.totalSuccesses > 0),
  };
}

function getOrCreateRecord(label: string, category: TaskCategory): FailureRecord {
  let rec = _metrics.get(label);
  if (!rec) {
    rec = {
      label,
      category,
      totalFailures: 0,
      lastFailure: null,
      lastError: null,
      totalRetries: 0,
      totalSuccesses: 0,
    };
    _metrics.set(label, rec);
  }
  return rec;
}

// ── Sleep helper ─────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Main API ─────────────────────────────────────────────────

const DEFAULT_OPTS: Record<TaskCategory, Required<ResilientOpts>> = {
  critical: { maxRetries: 3, baseDelayMs: 1_000, maxDelayMs: 15_000 },
  "best-effort": { maxRetries: 0, baseDelayMs: 1_000, maxDelayMs: 15_000 },
  cosmetic: { maxRetries: 0, baseDelayMs: 1_000, maxDelayMs: 15_000 },
};

/**
 * Fire-and-forget with resilience. Does NOT block the caller.
 *
 * Usage:
 *   resilientTask("syncResponse", "critical", () => syncResponse(supabase, sessionId, output));
 *   resilientTask("runPostMessageAssessment", "best-effort", () => runPostMessageAssessment(text, clean, anthropic));
 */
export function resilientTask(
  label: string,
  category: TaskCategory,
  fn: () => Promise<unknown>,
  opts?: ResilientOpts,
): void {
  const { maxRetries, baseDelayMs, maxDelayMs } = { ...DEFAULT_OPTS[category], ...opts };
  const record = getOrCreateRecord(label, category);

  // Fire-and-forget — caller is NOT awaiting this
  (async () => {
    let attempt = 0;
    while (true) {
      try {
        await fn();
        record.totalSuccesses++;
        return; // success
      } catch (err) {
        attempt++;
        const msg = err instanceof Error ? err.message : String(err);

        if (attempt > maxRetries) {
          // Final failure — log and record
          record.totalFailures++;
          record.lastFailure = Date.now();
          record.lastError = msg;
          if (category === "critical") {
            logger.error(`[${label}] Failed after ${attempt} attempt(s)`, { error: msg, category });
          } else {
            logger.warn(`[${label}] Failed`, { error: msg, category });
          }
          return;
        }

        // Retry with exponential backoff + jitter
        record.totalRetries++;
        const delayMs = Math.min(baseDelayMs * Math.pow(2, attempt - 1), maxDelayMs);
        const jitter = Math.floor(Math.random() * delayMs * 0.2);
        logger.warn(`[${label}] Attempt ${attempt}/${maxRetries + 1} failed, retrying in ${delayMs + jitter}ms`, { error: msg });
        await sleep(delayMs + jitter);
      }
    }
  })();
}
