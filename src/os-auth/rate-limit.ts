/**
 * OS Auth — Sliding Window Rate Limiter
 *
 * Supports three backends (tried in order):
 *   1. Redis-backed (preferred) — fast, survives restarts, supports clustering
 *   2. Postgres-backed (fallback) — survives restarts, higher latency
 *   3. In-memory Map (tests only) — zero-dep, no persistence
 *
 * Per-endpoint limits:
 *   register     : 5  requests / 15 min / IP
 *   login        : 10 requests / 15 min / IP
 *   refresh      : 30 requests / 15 min / IP
 *   verify-email : 10 requests / 15 min / IP
 */

import type { Sql } from "postgres"
import type Redis from "ioredis"

export type RateLimitedEndpoint = "register" | "login" | "refresh" | "verify-email"

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
  register:       { maxRequests: 5,  windowMs: 15 * 60 * 1000 },
  login:          { maxRequests: 10, windowMs: 15 * 60 * 1000 },
  refresh:        { maxRequests: 30, windowMs: 15 * 60 * 1000 },
  "verify-email": { maxRequests: 10, windowMs: 15 * 60 * 1000 },
}

// ── Postgres-backed rate limiter ───────────────────────────────

/**
 * Check and record a rate-limit attempt using Postgres.
 * Atomic: INSERT + COUNT in a single round-trip where possible.
 */
export async function checkRateLimitPg(
  sql: Sql,
  ip: string | null,
  endpoint: RateLimitedEndpoint,
  config?: RateLimitConfig,
): Promise<RateLimitResult> {
  const { maxRequests, windowMs } = config ?? RATE_LIMIT_CONFIGS[endpoint]
  const key = `${endpoint}:${ip ?? "unknown"}`
  const windowStart = new Date(Date.now() - windowMs)

  // Insert the new request and count recent requests in one transaction
  const [result] = await sql<{ cnt: string; oldest: Date | null }[]>`
    WITH inserted AS (
      INSERT INTO os_rate_limits (key) VALUES (${key}) RETURNING timestamp
    ),
    recent AS (
      SELECT timestamp FROM os_rate_limits
      WHERE key = ${key} AND timestamp > ${windowStart}
    )
    SELECT count(*)::text AS cnt, min(timestamp) AS oldest FROM recent
  `

  const count = parseInt(result.cnt, 10)

  if (count > maxRequests) {
    // Over limit — compute retryAfter from the oldest request in window
    const oldestMs = result.oldest ? result.oldest.getTime() : Date.now()
    const retryAfter = Math.ceil((oldestMs + windowMs - Date.now()) / 1000)
    return { allowed: false, retryAfter: Math.max(retryAfter, 1) }
  }

  return { allowed: true }
}

// ── Redis-backed rate limiter ──────────────────────────────────

/**
 * Check and record a rate-limit attempt using Redis sorted sets.
 * True sliding window: ZREMRANGEBYSCORE + ZADD + ZCARD in a pipeline.
 */
export async function checkRateLimitRedis(
  redis: Redis,
  ip: string | null,
  endpoint: RateLimitedEndpoint,
  config?: RateLimitConfig,
): Promise<RateLimitResult> {
  const { maxRequests, windowMs } = config ?? RATE_LIMIT_CONFIGS[endpoint]
  const key = `os:rl:${endpoint}:${ip ?? "unknown"}`
  const now = Date.now()
  const windowStart = now - windowMs
  // Unique member per request to avoid ZADD dedup
  const member = `${now}:${Math.random().toString(36).slice(2, 10)}`

  const results = await redis
    .multi()
    .zremrangebyscore(key, 0, windowStart)   // prune expired entries
    .zadd(key, now, member)                  // record this request
    .zcard(key)                              // count entries in window
    .pexpire(key, windowMs)                  // auto-cleanup TTL
    .exec()

  // results is [[err, val], ...] for each command
  if (!results) {
    // Pipeline failed — caller should fall back to Postgres
    throw new Error("Redis pipeline returned null")
  }

  const zcardResult = results[2]
  if (zcardResult[0]) throw zcardResult[0] // ZCARD error

  const count = zcardResult[1] as number

  if (count > maxRequests) {
    // Find oldest entry to compute retryAfter
    const oldest = await redis.zrange(key, 0, 0, "WITHSCORES")
    const oldestMs = oldest.length >= 2 ? parseInt(oldest[1], 10) : now
    const retryAfter = Math.ceil((oldestMs + windowMs - now) / 1000)
    return { allowed: false, retryAfter: Math.max(retryAfter, 1) }
  }

  return { allowed: true }
}

// ── In-memory rate limiter (fallback / tests) ──────────────────

// Map of "<endpoint>:<ip>" -> sorted list of request timestamps (ms)
const requestLog = new Map<string, number[]>()

/**
 * Check and record a rate-limit attempt (in-memory).
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
