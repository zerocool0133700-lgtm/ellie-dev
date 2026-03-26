/**
 * Consumer Failure Tracking & Backoff — ELLIE-1034
 * Tracks consecutive failures per UMS consumer.
 * Exponential backoff with auto-disable after threshold.
 */

import { log } from "../logger.ts";

const logger = log.child("ums:backoff");

const BASE_DELAY_MS = 5 * 60_000; // 5 minutes
const MAX_DELAY_MS = 24 * 60 * 60_000; // 24 hours
const DISABLE_THRESHOLD = 5; // consecutive failures before auto-disable

interface ConsumerState {
  failureCount: number;
  lastFailureAt: number;
  nextAttemptAt: number;
  disabled: boolean;
  lastError: string;
}

const consumerStates = new Map<string, ConsumerState>();

/** Calculate backoff delay: min(5min * 2^(count-1), 24h) */
export function calculateBackoffMs(failureCount: number): number {
  if (failureCount <= 0) return 0;
  return Math.min(BASE_DELAY_MS * Math.pow(2, failureCount - 1), MAX_DELAY_MS);
}

/** Record a consumer failure */
export function recordFailure(consumerName: string, error: string): ConsumerState {
  const existing = consumerStates.get(consumerName) || {
    failureCount: 0,
    lastFailureAt: 0,
    nextAttemptAt: 0,
    disabled: false,
    lastError: "",
  };

  existing.failureCount++;
  existing.lastFailureAt = Date.now();
  existing.lastError = error.slice(0, 500);
  existing.nextAttemptAt = Date.now() + calculateBackoffMs(existing.failureCount);

  if (existing.failureCount >= DISABLE_THRESHOLD) {
    existing.disabled = true;
    logger.error(`Consumer auto-disabled after ${DISABLE_THRESHOLD} consecutive failures`, {
      consumer: consumerName,
      lastError: error.slice(0, 200),
    });
  } else {
    logger.warn(`Consumer failure ${existing.failureCount}/${DISABLE_THRESHOLD}`, {
      consumer: consumerName,
      nextAttemptIn: `${Math.round(calculateBackoffMs(existing.failureCount) / 60_000)}m`,
    });
  }

  consumerStates.set(consumerName, existing);
  return existing;
}

/** Record a consumer success (resets failure count) */
export function recordSuccess(consumerName: string): void {
  const existing = consumerStates.get(consumerName);
  if (existing && existing.failureCount > 0) {
    logger.info(`Consumer recovered after ${existing.failureCount} failures`, { consumer: consumerName });
  }
  consumerStates.set(consumerName, {
    failureCount: 0,
    lastFailureAt: existing?.lastFailureAt || 0,
    nextAttemptAt: 0,
    disabled: false,
    lastError: existing?.lastError || "",
  });
}

/** Check if consumer should process (respects backoff + disabled) */
export function shouldProcess(consumerName: string): { allowed: boolean; reason?: string } {
  const state = consumerStates.get(consumerName);
  if (!state) return { allowed: true };

  if (state.disabled) {
    return { allowed: false, reason: `auto-disabled after ${state.failureCount} failures` };
  }

  if (Date.now() < state.nextAttemptAt) {
    const waitMs = state.nextAttemptAt - Date.now();
    return { allowed: false, reason: `backing off for ${Math.round(waitMs / 60_000)}m` };
  }

  return { allowed: true };
}

/** Manually reset/re-enable a consumer */
export function resetConsumer(consumerName: string): void {
  consumerStates.delete(consumerName);
  logger.info("Consumer manually reset", { consumer: consumerName });
}

/** Get all consumer states (for API/dashboard) */
export function getAllConsumerStates(): Record<string, ConsumerState> {
  const result: Record<string, ConsumerState> = {};
  for (const [name, state] of consumerStates) {
    result[name] = { ...state };
  }
  return result;
}

// Export constants for testing
export { BASE_DELAY_MS, MAX_DELAY_MS, DISABLE_THRESHOLD };
