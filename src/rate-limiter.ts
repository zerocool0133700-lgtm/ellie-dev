/**
 * Rate Limiter — sliding window + token bucket (ELLIE-228).
 *
 * Configurable per-key rate limiting for messages, API calls, and tools.
 * Uses in-memory sliding window: tracks timestamps of recent requests
 * and rejects when the count exceeds the limit within the window.
 */

import { log } from "./logger.ts";

const logger = log.child("rate-limit");

// ── Types ───────────────────────────────────────────────────

interface RateLimitConfig {
  maxRequests: number;    // max requests per window
  windowMs: number;       // sliding window in ms
  name: string;           // human-readable name for logging
}

interface RateLimitResult {
  allowed: boolean;
  remaining: number;      // requests remaining in window
  retryAfterMs?: number;  // ms until a slot opens (if rejected)
}

// ── Sliding Window Rate Limiter ─────────────────────────────

class SlidingWindowLimiter {
  private windows = new Map<string, number[]>();
  private readonly config: RateLimitConfig;

  constructor(config: RateLimitConfig) {
    this.config = config;
  }

  check(key: string): RateLimitResult {
    const now = Date.now();
    const cutoff = now - this.config.windowMs;

    // Get or create window
    let timestamps = this.windows.get(key);
    if (!timestamps) {
      timestamps = [];
      this.windows.set(key, timestamps);
    }

    // Prune expired entries
    while (timestamps.length > 0 && timestamps[0] <= cutoff) {
      timestamps.shift();
    }

    if (timestamps.length >= this.config.maxRequests) {
      // Rejected — calculate when the oldest entry expires
      const retryAfterMs = timestamps[0] - cutoff;
      logger.warn(`Rate limited: ${this.config.name}`, {
        key,
        limit: this.config.maxRequests,
        window: this.config.windowMs,
        retryAfterMs,
      });
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs,
      };
    }

    // Allowed — record this request
    timestamps.push(now);
    return {
      allowed: true,
      remaining: this.config.maxRequests - timestamps.length,
    };
  }

  /** Get current count for a key without recording a request. */
  peek(key: string): number {
    const now = Date.now();
    const cutoff = now - this.config.windowMs;
    const timestamps = this.windows.get(key);
    if (!timestamps) return 0;
    return timestamps.filter(t => t > cutoff).length;
  }

  /** Cleanup all expired windows. Call periodically to prevent memory leaks. */
  cleanup(): void {
    const now = Date.now();
    const cutoff = now - this.config.windowMs;
    for (const [key, timestamps] of this.windows) {
      while (timestamps.length > 0 && timestamps[0] <= cutoff) {
        timestamps.shift();
      }
      if (timestamps.length === 0) {
        this.windows.delete(key);
      }
    }
  }
}

// ── Pre-configured limiters ─────────────────────────────────

/** Per-user message rate limit (30 messages per minute). */
export const messageLimiter = new SlidingWindowLimiter({
  name: "message",
  maxRequests: parseInt(process.env.RATE_LIMIT_MESSAGES || "30"),
  windowMs: 60_000,
});

/** Per-channel rate limit — voice is more expensive. */
export const voiceLimiter = new SlidingWindowLimiter({
  name: "voice",
  maxRequests: parseInt(process.env.RATE_LIMIT_VOICE || "10"),
  windowMs: 60_000,
});

/** Per-user API rate limit for HTTP endpoints (60 req/min). */
export const apiLimiter = new SlidingWindowLimiter({
  name: "api",
  maxRequests: parseInt(process.env.RATE_LIMIT_API || "60"),
  windowMs: 60_000,
});

/** MCP tool call rate limit (100 calls per minute per tool). */
export const toolLimiter = new SlidingWindowLimiter({
  name: "tool",
  maxRequests: parseInt(process.env.RATE_LIMIT_TOOLS || "100"),
  windowMs: 60_000,
});

// ── Convenience helpers ─────────────────────────────────────

/**
 * Check if a message from a user/channel is rate-limited.
 * Returns a friendly message if limited, or null if allowed.
 */
export function checkMessageRate(userId: string, channel: string): string | null {
  const result = messageLimiter.check(`${channel}:${userId}`);
  if (!result.allowed) {
    const retrySeconds = Math.ceil((result.retryAfterMs ?? 0) / 1000);
    return `I need a quick breather — you're sending messages faster than I can process them. Try again in ${retrySeconds}s.`;
  }
  return null;
}

/**
 * Check voice call rate limit.
 */
export function checkVoiceRate(userId: string): string | null {
  const result = voiceLimiter.check(userId);
  if (!result.allowed) {
    const retrySeconds = Math.ceil((result.retryAfterMs ?? 0) / 1000);
    return `Voice calls are limited. Please try again in ${retrySeconds}s.`;
  }
  return null;
}

/**
 * Check API endpoint rate limit. Returns HTTP 429 response if limited.
 */
export function checkApiRate(key: string): Response | null {
  const result = apiLimiter.check(key);
  if (!result.allowed) {
    return new Response(
      JSON.stringify({ error: "Rate limited", retryAfterMs: result.retryAfterMs }),
      {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": String(Math.ceil((result.retryAfterMs ?? 0) / 1000)),
        },
      },
    );
  }
  return null;
}

/** Get status of all limiters (for health endpoint). */
export function getRateLimitStatus() {
  return {
    message: { activeKeys: messageLimiter.peek("_all") },
    voice: { activeKeys: voiceLimiter.peek("_all") },
    api: { activeKeys: apiLimiter.peek("_all") },
    tool: { activeKeys: toolLimiter.peek("_all") },
  };
}

// ── Periodic cleanup (prevent memory leaks from stale keys) ──

setInterval(() => {
  messageLimiter.cleanup();
  voiceLimiter.cleanup();
  apiLimiter.cleanup();
  toolLimiter.cleanup();
}, 300_000); // Every 5 minutes
