/**
 * Dispatch Retry — ELLIE-392
 *
 * Auto-retry failed dispatches with exponential backoff + jitter.
 * Classifies errors as retryable (network, timeout, 5xx) vs permanent
 * (4xx, validation, auth). Only retries transient failures.
 *
 * Max 3 retries: ~1s, ~4s, ~16s (with jitter).
 */

import { log } from "./logger.ts";
import { emitEvent } from "./orchestration-ledger.ts";

const logger = log.child("dispatch-retry");

// ── Configuration ───────────────────────────────────────────

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1_000;
const BACKOFF_MULTIPLIER = 4;
const MAX_JITTER_MS = 500;

// ── Error Classification ────────────────────────────────────

export type ErrorClass = "retryable" | "permanent";

/**
 * Classify an error as retryable or permanent.
 *
 * Retryable: network errors, timeouts, 5xx responses, rate limits (429),
 *            "ECONNRESET", "ENOTFOUND", "ETIMEDOUT", "socket hang up",
 *            edge function unavailable.
 *
 * Permanent: 4xx (except 429), validation errors, auth failures,
 *            missing resources (agent/ticket not found), cost exceeded.
 */
export function classifyError(error: unknown): { errorClass: ErrorClass; reason: string } {
  const msg = error instanceof Error ? error.message : String(error);
  const lower = msg.toLowerCase();

  // Network / connection errors → retryable
  const networkPatterns = [
    "econnreset", "econnrefused", "enotfound", "etimedout",
    "socket hang up", "network error", "fetch failed",
    "dns resolution", "connection refused", "aborted",
  ];
  for (const pat of networkPatterns) {
    if (lower.includes(pat)) {
      return { errorClass: "retryable", reason: `network: ${pat}` };
    }
  }

  // Timeout → retryable
  if (lower.includes("timeout") || lower.includes("timed out")) {
    return { errorClass: "retryable", reason: "timeout" };
  }

  // 5xx server errors → retryable
  if (/\b5\d{2}\b/.test(msg) || lower.includes("internal server error") || lower.includes("bad gateway") || lower.includes("service unavailable")) {
    return { errorClass: "retryable", reason: "server_error" };
  }

  // Rate limit (429) → retryable
  if (lower.includes("rate limit") || lower.includes("429") || lower.includes("too many requests")) {
    return { errorClass: "retryable", reason: "rate_limited" };
  }

  // Edge function unavailable → retryable
  if (lower.includes("edge function") || lower.includes("function not found") || lower.includes("relay error")) {
    return { errorClass: "retryable", reason: "edge_unavailable" };
  }

  // Overloaded → retryable
  if (lower.includes("overloaded") || lower.includes("capacity")) {
    return { errorClass: "retryable", reason: "overloaded" };
  }

  // Auth failures → permanent
  if (lower.includes("unauthorized") || lower.includes("forbidden") || lower.includes("401") || lower.includes("403") || lower.includes("invalid api key")) {
    return { errorClass: "permanent", reason: "auth_failure" };
  }

  // Not found (agent, ticket) → permanent
  if (lower.includes("not found") || lower.includes("404") || lower.includes("agent not found") || lower.includes("ticket not found")) {
    return { errorClass: "permanent", reason: "not_found" };
  }

  // Cost/validation → permanent
  if (lower.includes("cost exceed") || lower.includes("validation") || lower.includes("invalid") || lower.includes("cost_exceeded")) {
    return { errorClass: "permanent", reason: "validation" };
  }

  // Dispatch-specific permanent errors
  if (lower.includes("dispatch_failed") && lower.includes("agent")) {
    return { errorClass: "permanent", reason: "dispatch_config" };
  }

  // Default: treat unknown errors as retryable (conservative — prefer retry over silent failure)
  return { errorClass: "retryable", reason: "unknown" };
}

// ── Delay Calculation ───────────────────────────────────────

/** Calculate delay with exponential backoff + jitter. */
export function calculateDelay(attempt: number): number {
  const exponential = BASE_DELAY_MS * Math.pow(BACKOFF_MULTIPLIER, attempt);
  const jitter = Math.floor(Math.random() * MAX_JITTER_MS);
  return exponential + jitter;
}

// ── Retry Wrapper ───────────────────────────────────────────

export interface RetryOptions {
  /** Run ID for ledger event emission. */
  runId?: string;
  /** Agent type for logging context. */
  agentType?: string;
  /** Work item ID for logging context. */
  workItemId?: string;
  /** Override max retries (default: 3). */
  maxRetries?: number;
}

export interface RetryResult<T> {
  success: boolean;
  result?: T;
  error?: Error;
  attempts: number;
  retryHistory: Array<{
    attempt: number;
    errorClass: ErrorClass;
    reason: string;
    delayMs: number;
  }>;
}

/**
 * Execute a function with automatic retry on transient failures.
 * Returns the result on success, or the final error after exhausting retries.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<RetryResult<T>> {
  const maxRetries = opts.maxRetries ?? MAX_RETRIES;
  const retryHistory: RetryResult<T>["retryHistory"] = [];
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await fn();
      if (attempt > 0) {
        logger.info("Retry succeeded", {
          attempt,
          runId: opts.runId?.slice(0, 8),
          agentType: opts.agentType,
          workItemId: opts.workItemId,
        });
      }
      return { success: true, result, attempts: attempt + 1, retryHistory };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const { errorClass, reason } = classifyError(err);

      // Permanent error — don't retry
      if (errorClass === "permanent") {
        logger.warn("Permanent error — no retry", {
          attempt,
          reason,
          error: lastError.message.slice(0, 200),
          runId: opts.runId?.slice(0, 8),
          agentType: opts.agentType,
        });

        if (opts.runId) {
          emitEvent(opts.runId, "failed", opts.agentType || null, opts.workItemId || null, {
            error: lastError.message.slice(0, 500),
            error_class: "permanent",
            reason,
            attempt,
          });
        }

        return { success: false, error: lastError, attempts: attempt + 1, retryHistory };
      }

      // Retryable — check if we have retries left
      if (attempt < maxRetries) {
        const delayMs = calculateDelay(attempt);
        retryHistory.push({ attempt, errorClass, reason, delayMs });

        logger.warn("Retryable error — will retry", {
          attempt: attempt + 1,
          maxRetries,
          delayMs,
          reason,
          error: lastError.message.slice(0, 200),
          runId: opts.runId?.slice(0, 8),
          agentType: opts.agentType,
          workItemId: opts.workItemId,
        });

        if (opts.runId) {
          emitEvent(opts.runId, "retried", opts.agentType || null, opts.workItemId || null, {
            attempt: attempt + 1,
            reason,
            delay_ms: delayMs,
            error: lastError.message.slice(0, 500),
          });
        }

        await sleep(delayMs);
      } else {
        // Exhausted all retries
        retryHistory.push({ attempt, errorClass, reason, delayMs: 0 });

        logger.error("Retries exhausted", {
          attempts: attempt + 1,
          reason,
          error: lastError.message.slice(0, 200),
          runId: opts.runId?.slice(0, 8),
          agentType: opts.agentType,
          workItemId: opts.workItemId,
          retryHistory,
        });

        if (opts.runId) {
          emitEvent(opts.runId, "failed", opts.agentType || null, opts.workItemId || null, {
            error: lastError.message.slice(0, 500),
            error_class: "retryable_exhausted",
            reason,
            total_attempts: attempt + 1,
            retry_history: retryHistory,
          });
        }
      }
    }
  }

  return { success: false, error: lastError, attempts: maxRetries + 1, retryHistory };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
