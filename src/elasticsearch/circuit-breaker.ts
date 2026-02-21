/**
 * ES Forest — Circuit Breaker (ELLIE-111)
 *
 * Wraps Elasticsearch calls with timeout and automatic fallback.
 * Three states: CLOSED (normal), OPEN (failing), HALF_OPEN (testing).
 *
 * When ES fails repeatedly, the breaker opens and all calls return
 * fallback values immediately — no wasted time waiting for timeouts.
 * Periodically retests to auto-recover when ES comes back.
 */

type BreakerState = "closed" | "open" | "half_open";

interface BreakerConfig {
  failureThreshold: number;  // failures before opening
  resetTimeout: number;      // ms before trying again
  callTimeout: number;       // ms per-call timeout
}

const DEFAULT_CONFIG: BreakerConfig = {
  failureThreshold: 3,
  resetTimeout: 30_000,
  callTimeout: 2000,
};

let state: BreakerState = "closed";
let failureCount = 0;
let lastFailure = 0;
let config = { ...DEFAULT_CONFIG };

export function configureBreaker(overrides: Partial<BreakerConfig>): void {
  config = { ...DEFAULT_CONFIG, ...overrides };
}

export function getBreakerState(): { state: BreakerState; failures: number } {
  // Auto-transition from open → half_open when reset timeout expires
  if (state === "open" && Date.now() - lastFailure >= config.resetTimeout) {
    state = "half_open";
  }
  return { state, failures: failureCount };
}

function recordSuccess(): void {
  failureCount = 0;
  state = "closed";
}

function recordFailure(): void {
  failureCount++;
  lastFailure = Date.now();
  if (failureCount >= config.failureThreshold) {
    state = "open";
    console.warn(`[es-breaker] Circuit OPEN after ${failureCount} failures, pausing for ${config.resetTimeout}ms`);
  }
}

/**
 * Execute a function through the circuit breaker.
 * Returns fallback value if the breaker is open or the call fails/times out.
 */
export async function withBreaker<T>(
  fn: () => Promise<T>,
  fallback: T
): Promise<T> {
  const { state: currentState } = getBreakerState();

  if (currentState === "open") {
    return fallback;
  }

  try {
    const result = await Promise.race([
      fn(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Circuit breaker timeout")), config.callTimeout)
      ),
    ]);
    recordSuccess();
    return result;
  } catch (err) {
    recordFailure();
    if (currentState === "half_open") {
      console.warn("[es-breaker] Half-open test failed, re-opening circuit");
    }
    return fallback;
  }
}

/**
 * Reset the breaker manually (e.g., after confirming ES is back).
 */
export function resetBreaker(): void {
  state = "closed";
  failureCount = 0;
  lastFailure = 0;
}
