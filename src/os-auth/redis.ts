/**
 * OS Auth — Redis Client
 *
 * Lazy-init Redis connection for rate limiting.
 * Returns null when REDIS_URL is not configured — callers fall back to Postgres.
 */

import Redis from "ioredis"
import { log } from "../logger.ts"

const logger = log.child("os-auth-redis")

let client: Redis | null = null
let attempted = false

/**
 * Get a shared Redis client. Returns null if REDIS_URL is not set
 * or the connection failed.
 */
export function getRedisClient(): Redis | null {
  if (attempted) return client

  attempted = true
  const url = process.env.REDIS_URL
  if (!url) {
    logger.info("REDIS_URL not set — rate limiting will use Postgres")
    return null
  }

  try {
    client = new Redis(url, {
      maxRetriesPerRequest: 1,
      retryStrategy(times) {
        if (times > 3) return null // stop retrying
        return Math.min(times * 200, 2000)
      },
      lazyConnect: true,
    })

    client.on("error", (err) => {
      logger.warn("Redis connection error — falling back to Postgres", { error: String(err) })
    })

    client.connect().catch(() => {
      // Connection failure is non-fatal; checkRateLimitRedis will throw
      // and the caller falls back to Postgres
      client = null
    })
  } catch {
    logger.warn("Failed to create Redis client")
    client = null
  }

  return client
}

/**
 * Disconnect Redis client. For use during graceful shutdown.
 */
export async function disconnectRedis(): Promise<void> {
  if (client) {
    await client.quit().catch(() => {})
    client = null
    attempted = false
  }
}

/** Reset for testing. */
export function _resetRedisClient(): void {
  client = null
  attempted = false
}
