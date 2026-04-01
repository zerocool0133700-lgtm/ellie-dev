/**
 * OS Auth — Sliding Window Rate Limiter
 *
 * In-memory rate limiter using a sliding window approach.
 * Suitable for single-process Bun/Node servers (no Redis needed).
 *
 * Per-endpoint limits:
 *   register : 5  requests / 15 min / IP
 *   login    : 10 requests / 15 min / IP
 *   refresh  : 30 requests / 15 min / IP
 */

export type RateLimitedEndpoint = "register" | "login" | "refresh"

export interface RateLimitConfig {
  maxRequests: number
  windowMs: number
}

export interface RateLimitResult {
  allowed: boolean
  /** Seconds until the oldest request falls out of the window. Only set when blocked. */
  retryAfter?: number
}

// Default per-endpoint configs
export const RATE_LIMIT_CONFIGS: Record<RateLimitedEndpoint, RateLimitConfig> = {
  register: { maxRequests: 5,  windowMs: 15 * 60 * 1000 },
  login:    { maxRequests: 10, windowMs: 15 * 60 * 1000 },
  refresh:  { maxRequests: 30, windowMs: 15 * 60 * 1000 },
}

// Map of "<endpoint>:<ip>" → sorted list of request timestamps (ms)
const requestLog = new Map<string, number[]>()

/**
 * Check and record a rate-limit attempt.
 *
 * @param ip       - Client IP address (string). If null/empty, treated as "unknown".
 * @param endpoint - The endpoint being accessed.
 * @param now      - Current timestamp in ms (injectable for testing, defaults to Date.now()).
 * @param config   - Optional override for maxRequests / windowMs.
 */
export function checkRateLimit(
  ip: string | null,
  endpoint: RateLimitedEndpoint,
  now: number = Date.now(),
  config?: RateLimitConfig,
): RateLimitResult {
  const { maxRequests, windowMs } = config ?? RATE_LIMIT_CONFIGS[endpoint]
  const key = `${endpoint}:${ip ?? "unknown"}`
  const windowStart = now - windowMs

  // Retrieve existing timestamps, pruning anything outside the window
  const timestamps = (requestLog.get(key) ?? []).filter(ts => ts > windowStart)

  // Evict stale keys to prevent unbounded map growth from scanning traffic
  if (timestamps.length === 0 && requestLog.has(key)) {
    requestLog.delete(key)
  }

  if (timestamps.length >= maxRequests) {
    // Oldest timestamp in window — time until it falls out
    const oldestInWindow = timestamps[0]
    const retryAfter = Math.ceil((oldestInWindow + windowMs - now) / 1000)
    requestLog.set(key, timestamps)
    return { allowed: false, retryAfter: Math.max(retryAfter, 1) }
  }

  // Allow — record this request
  timestamps.push(now)
  requestLog.set(key, timestamps)
  return { allowed: true }
}

/**
 * Reset all rate-limit state. For use in tests only.
 */
export function _resetRateLimits(): void {
  requestLog.clear()
}
