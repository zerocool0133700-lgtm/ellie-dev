import { describe, test, expect, beforeEach } from "bun:test"
import { checkRateLimit, _resetRateLimits, RATE_LIMIT_CONFIGS } from "../src/os-auth/rate-limit"

// Reset state between every test
beforeEach(() => {
  _resetRateLimits()
})

describe("os-auth rate limiter — basic allow/block", () => {
  test("allows requests under the limit", () => {
    const limit = RATE_LIMIT_CONFIGS.login.maxRequests
    for (let i = 0; i < limit; i++) {
      const result = checkRateLimit("1.2.3.4", "login")
      expect(result.allowed).toBe(true)
    }
  })

  test("blocks the (limit + 1)th request", () => {
    const limit = RATE_LIMIT_CONFIGS.login.maxRequests
    for (let i = 0; i < limit; i++) {
      checkRateLimit("1.2.3.4", "login")
    }
    const blocked = checkRateLimit("1.2.3.4", "login")
    expect(blocked.allowed).toBe(false)
  })

  test("register limit is 5 per 15 min", () => {
    const ip = "10.0.0.1"
    for (let i = 0; i < 5; i++) {
      expect(checkRateLimit(ip, "register").allowed).toBe(true)
    }
    expect(checkRateLimit(ip, "register").allowed).toBe(false)
  })

  test("refresh limit is 30 per 15 min", () => {
    const ip = "10.0.0.2"
    for (let i = 0; i < 30; i++) {
      expect(checkRateLimit(ip, "refresh").allowed).toBe(true)
    }
    expect(checkRateLimit(ip, "refresh").allowed).toBe(false)
  })
})

describe("os-auth rate limiter — Retry-After header", () => {
  test("returns retryAfter when blocked", () => {
    const ip = "5.5.5.5"
    const config = { maxRequests: 2, windowMs: 60_000 }
    const now = 1_000_000

    checkRateLimit(ip, "login", now, config)
    checkRateLimit(ip, "login", now + 1_000, config)   // fills limit

    const blocked = checkRateLimit(ip, "login", now + 2_000, config)
    expect(blocked.allowed).toBe(false)
    // Oldest request is at now=1_000_000, window=60s → expires at 1_060_000ms
    // Current time is 1_002_000ms → retryAfter = ceil((1_060_000 - 1_002_000)/1000) = 58s
    expect(blocked.retryAfter).toBe(58)
  })

  test("retryAfter is at least 1", () => {
    const ip = "6.6.6.6"
    // Fill limit, check that retryAfter is >= 1 when nearly expired
    const config = { maxRequests: 1, windowMs: 2_000 } // 2 second window
    const t0 = 1_000_000
    checkRateLimit(ip, "register", t0, config)
    // One millisecond before the window expires: retryAfter should be 1s (ceil of <1s)
    const blocked = checkRateLimit(ip, "register", t0 + 1_999, config)
    expect(blocked.allowed).toBe(false)
    expect(blocked.retryAfter).toBeGreaterThanOrEqual(1)
  })

  test("allowed requests do not set retryAfter", () => {
    const result = checkRateLimit("7.7.7.7", "login")
    expect(result.allowed).toBe(true)
    expect(result.retryAfter).toBeUndefined()
  })
})

describe("os-auth rate limiter — per-endpoint isolation", () => {
  test("login and register are tracked separately for the same IP", () => {
    const ip = "9.9.9.9"
    const loginConfig = { maxRequests: 2, windowMs: 60_000 }
    const registerConfig = { maxRequests: 2, windowMs: 60_000 }

    checkRateLimit(ip, "login", Date.now(), loginConfig)
    checkRateLimit(ip, "login", Date.now(), loginConfig)

    // Login limit hit
    expect(checkRateLimit(ip, "login", Date.now(), loginConfig).allowed).toBe(false)
    // Register is unaffected
    expect(checkRateLimit(ip, "register", Date.now(), registerConfig).allowed).toBe(true)
  })
})

describe("os-auth rate limiter — per-IP isolation", () => {
  test("different IPs are tracked independently", () => {
    const config = { maxRequests: 2, windowMs: 60_000 }
    const now = Date.now()

    checkRateLimit("ip-A", "login", now, config)
    checkRateLimit("ip-A", "login", now, config)
    // ip-A is now blocked
    expect(checkRateLimit("ip-A", "login", now, config).allowed).toBe(false)
    // ip-B is fresh
    expect(checkRateLimit("ip-B", "login", now, config).allowed).toBe(true)
  })

  test("null IP is treated as 'unknown' and isolated from real IPs", () => {
    const config = { maxRequests: 1, windowMs: 60_000 }
    const now = Date.now()

    checkRateLimit(null, "login", now, config)
    // null is blocked
    expect(checkRateLimit(null, "login", now, config).allowed).toBe(false)
    // real IP is unaffected
    expect(checkRateLimit("192.168.0.1", "login", now, config).allowed).toBe(true)
  })
})

describe("os-auth rate limiter — window expiry", () => {
  test("requests outside the window are pruned and new requests are allowed", () => {
    const ip = "8.8.8.8"
    const config = { maxRequests: 2, windowMs: 10_000 } // 10 second window
    const t0 = 100_000

    // Fill limit at t0
    checkRateLimit(ip, "login", t0, config)
    checkRateLimit(ip, "login", t0, config)
    expect(checkRateLimit(ip, "login", t0, config).allowed).toBe(false)

    // Advance time past the window — old entries are pruned
    const t1 = t0 + 11_000
    expect(checkRateLimit(ip, "login", t1, config).allowed).toBe(true)
  })
})

describe("os-auth rate limiter — reset function", () => {
  test("_resetRateLimits clears all state", () => {
    const config = { maxRequests: 1, windowMs: 60_000 }
    const ip = "11.11.11.11"

    checkRateLimit(ip, "login", Date.now(), config)
    expect(checkRateLimit(ip, "login", Date.now(), config).allowed).toBe(false)

    _resetRateLimits()

    expect(checkRateLimit(ip, "login", Date.now(), config).allowed).toBe(true)
  })
})
