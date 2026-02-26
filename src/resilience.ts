/**
 * Resilience utilities — circuit breaker + retry with exponential backoff.
 *
 * Generalizes the ES-specific circuit breaker (ELLIE-111) into a reusable
 * pattern for all external service calls. ELLIE-227.
 */

import { log } from "./logger.ts";

const logger = log.child("resilience");

// ── Circuit Breaker ─────────────────────────────────────────

type BreakerState = "closed" | "open" | "half_open";

interface CircuitBreakerOpts {
  name: string;
  failureThreshold?: number;  // failures before opening (default: 3)
  resetTimeoutMs?: number;    // ms before half-open test (default: 30s)
  callTimeoutMs?: number;     // per-call timeout in ms (default: 5s)
}

export class CircuitBreaker {
  readonly name: string;
  private state: BreakerState = "closed";
  private failureCount = 0;
  private lastFailure = 0;
  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly callTimeoutMs: number;

  constructor(opts: CircuitBreakerOpts) {
    this.name = opts.name;
    this.failureThreshold = opts.failureThreshold ?? 3;
    this.resetTimeoutMs = opts.resetTimeoutMs ?? 30_000;
    this.callTimeoutMs = opts.callTimeoutMs ?? 5_000;
  }

  getState(): { state: BreakerState; failures: number } {
    if (this.state === "open" && Date.now() - this.lastFailure >= this.resetTimeoutMs) {
      this.state = "half_open";
    }
    return { state: this.state, failures: this.failureCount };
  }

  private recordSuccess(): void {
    if (this.state !== "closed") {
      logger.info(`${this.name} circuit CLOSED — recovered`, { service: this.name });
    }
    this.failureCount = 0;
    this.state = "closed";
  }

  private recordFailure(): void {
    this.failureCount++;
    this.lastFailure = Date.now();
    if (this.failureCount >= this.failureThreshold) {
      this.state = "open";
      logger.warn(`${this.name} circuit OPEN — pausing calls`, {
        service: this.name,
        failures: this.failureCount,
        pauseMs: this.resetTimeoutMs,
      });
    }
  }

  reset(): void {
    this.state = "closed";
    this.failureCount = 0;
    this.lastFailure = 0;
  }

  /**
   * Execute a function through the circuit breaker.
   * Returns fallback if breaker is open or call fails/times out.
   */
  async call<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
    const { state } = this.getState();

    if (state === "open") {
      return fallback;
    }

    try {
      const result = await Promise.race([
        fn(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`${this.name} circuit breaker timeout`)), this.callTimeoutMs)
        ),
      ]);
      this.recordSuccess();
      return result;
    } catch (err) {
      this.recordFailure();
      if (state === "half_open") {
        logger.warn(`${this.name} half-open test failed — re-opening`, { service: this.name });
      }
      return fallback;
    }
  }
}

// ── Retry with Exponential Backoff ──────────────────────────

interface RetryOpts {
  maxRetries?: number;      // default: 3
  baseDelayMs?: number;     // default: 500ms
  maxDelayMs?: number;      // default: 10s
  retryOn?: (err: unknown) => boolean;  // default: retry on all errors
}

/**
 * Retry a function with exponential backoff.
 * Delay doubles each attempt: 500ms, 1s, 2s, 4s... capped at maxDelayMs.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts?: RetryOpts,
): Promise<T> {
  const maxRetries = opts?.maxRetries ?? 3;
  const baseDelay = opts?.baseDelayMs ?? 500;
  const maxDelay = opts?.maxDelayMs ?? 10_000;
  const shouldRetry = opts?.retryOn ?? (() => true);

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt >= maxRetries || !shouldRetry(err)) {
        throw err;
      }
      const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

/**
 * Check if an HTTP error is transient (worth retrying).
 * Retries on: 429, 500, 502, 503, 504, network errors.
 */
export function isTransientError(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    // Network errors
    if (msg.includes("fetch failed") || msg.includes("econnrefused") ||
        msg.includes("econnreset") || msg.includes("etimedout") ||
        msg.includes("enetunreach") || msg.includes("socket hang up")) {
      return true;
    }
    // HTTP status codes
    const statusMatch = msg.match(/(\d{3})/);
    if (statusMatch) {
      const status = parseInt(statusMatch[1]);
      return status === 429 || status >= 500;
    }
  }
  return true; // default: assume transient
}

// ── Pre-configured service breakers ─────────────────────────

export const breakers = {
  plane: new CircuitBreaker({
    name: "plane",
    failureThreshold: 3,
    resetTimeoutMs: 60_000,
    callTimeoutMs: 10_000,
  }),
  bridge: new CircuitBreaker({
    name: "bridge",
    failureThreshold: 3,
    resetTimeoutMs: 30_000,
    callTimeoutMs: 5_000,
  }),
  outlook: new CircuitBreaker({
    name: "outlook",
    failureThreshold: 3,
    resetTimeoutMs: 60_000,
    callTimeoutMs: 15_000,
  }),
  googleChat: new CircuitBreaker({
    name: "google-chat",
    failureThreshold: 3,
    resetTimeoutMs: 30_000,
    callTimeoutMs: 10_000,
  }),
};

/** Get status of all breakers (for health endpoint). */
export function getBreakerStatus(): Record<string, { state: BreakerState; failures: number }> {
  const result: Record<string, { state: BreakerState; failures: number }> = {};
  for (const [name, breaker] of Object.entries(breakers)) {
    result[name] = breaker.getState();
  }
  return result;
}
