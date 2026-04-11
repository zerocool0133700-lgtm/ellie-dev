import { describe, test, expect, beforeEach } from "bun:test"
import { checkRateLimitPg, RATE_LIMIT_CONFIGS } from "../src/os-auth/rate-limit"

// ── Mock SQL ───────────────────────────────────────────────────

interface MockSqlCall {
  strings: TemplateStringsArray
  values: unknown[]
}

function createMockSql(returnValue: any = []) {
  const calls: MockSqlCall[] = []
  const fn: any = function (strings: TemplateStringsArray, ...values: unknown[]) {
    calls.push({ strings, values })
    return Promise.resolve(returnValue)
  }
  fn.calls = calls
  return fn
}

// ── Tests ──────────────────────────────────────────────────────

describe("checkRateLimitPg — allows under limit", () => {
  test("allows when count is within limit", async () => {
    const sql = createMockSql([{ cnt: "1", oldest: new Date() }])
    const result = await checkRateLimitPg(sql, "1.2.3.4", "login")
    expect(result.allowed).toBe(true)
    expect(result.retryAfter).toBeUndefined()
  })

  test("allows when count equals maxRequests", async () => {
    const sql = createMockSql([{ cnt: "10", oldest: new Date() }])
    const result = await checkRateLimitPg(sql, "1.2.3.4", "login")
    expect(result.allowed).toBe(true)
  })

  test("passes correct key to SQL", async () => {
    const sql = createMockSql([{ cnt: "1", oldest: new Date() }])
    await checkRateLimitPg(sql, "10.0.0.1", "register")
    // The key should be "register:10.0.0.1" — check interpolated values
    expect(sql.calls.length).toBe(1)
    expect(sql.calls[0].values[0]).toBe("register:10.0.0.1")
  })

  test("treats null IP as 'unknown'", async () => {
    const sql = createMockSql([{ cnt: "1", oldest: new Date() }])
    await checkRateLimitPg(sql, null, "login")
    expect(sql.calls[0].values[0]).toBe("login:unknown")
  })
})

describe("checkRateLimitPg — blocks over limit", () => {
  test("blocks when count exceeds maxRequests", async () => {
    const oldest = new Date(Date.now() - 5_000) // 5 seconds ago
    const sql = createMockSql([{ cnt: "11", oldest }])
    const result = await checkRateLimitPg(sql, "1.2.3.4", "login")
    expect(result.allowed).toBe(false)
    expect(result.retryAfter).toBeGreaterThanOrEqual(1)
  })

  test("retryAfter is at least 1 second", async () => {
    // oldest is almost at the edge of the window
    const windowMs = RATE_LIMIT_CONFIGS.login.windowMs
    const oldest = new Date(Date.now() - windowMs + 100) // nearly expired
    const sql = createMockSql([{ cnt: "11", oldest }])
    const result = await checkRateLimitPg(sql, "1.2.3.4", "login")
    expect(result.allowed).toBe(false)
    expect(result.retryAfter).toBeGreaterThanOrEqual(1)
  })

  test("retryAfter reflects time until oldest request expires", async () => {
    const windowMs = 15 * 60 * 1000
    // Oldest request was 5 minutes ago → 10 minutes remaining
    const oldest = new Date(Date.now() - 5 * 60 * 1000)
    const sql = createMockSql([{ cnt: "11", oldest }])
    const result = await checkRateLimitPg(sql, "1.2.3.4", "login", { maxRequests: 10, windowMs })
    expect(result.allowed).toBe(false)
    // ~600 seconds remaining (10 minutes)
    expect(result.retryAfter).toBeGreaterThan(590)
    expect(result.retryAfter).toBeLessThanOrEqual(600)
  })

  test("retryAfter defaults sanely when oldest is null", async () => {
    const sql = createMockSql([{ cnt: "11", oldest: null }])
    const result = await checkRateLimitPg(sql, "1.2.3.4", "login")
    expect(result.allowed).toBe(false)
    // With null oldest, uses Date.now() — retryAfter should be ~full window
    expect(result.retryAfter).toBeGreaterThan(0)
  })
})

describe("checkRateLimitPg — per-endpoint configs", () => {
  test("register limit is 5", async () => {
    const sql = createMockSql([{ cnt: "6", oldest: new Date() }])
    const result = await checkRateLimitPg(sql, "1.2.3.4", "register")
    expect(result.allowed).toBe(false)
  })

  test("refresh limit is 30", async () => {
    const sql = createMockSql([{ cnt: "30", oldest: new Date() }])
    const result = await checkRateLimitPg(sql, "1.2.3.4", "refresh")
    expect(result.allowed).toBe(true)
  })

  test("verify-email limit is 10", async () => {
    const sql = createMockSql([{ cnt: "11", oldest: new Date() }])
    const result = await checkRateLimitPg(sql, "1.2.3.4", "verify-email")
    expect(result.allowed).toBe(false)
  })
})

describe("checkRateLimitPg — custom config override", () => {
  test("respects custom maxRequests", async () => {
    const sql = createMockSql([{ cnt: "3", oldest: new Date() }])
    const result = await checkRateLimitPg(sql, "1.2.3.4", "login", { maxRequests: 2, windowMs: 60_000 })
    expect(result.allowed).toBe(false)
  })

  test("respects custom windowMs for retryAfter calculation", async () => {
    const windowMs = 30_000 // 30 seconds
    const oldest = new Date(Date.now() - 10_000) // 10s ago
    const sql = createMockSql([{ cnt: "3", oldest }])
    const result = await checkRateLimitPg(sql, "1.2.3.4", "login", { maxRequests: 2, windowMs })
    expect(result.allowed).toBe(false)
    // 30s window, oldest 10s ago → ~20s remaining
    expect(result.retryAfter).toBeGreaterThan(18)
    expect(result.retryAfter).toBeLessThanOrEqual(20)
  })
})

describe("checkRateLimitPg — SQL window parameter", () => {
  test("passes windowStart as Date to SQL", async () => {
    const before = Date.now()
    const sql = createMockSql([{ cnt: "1", oldest: new Date() }])
    await checkRateLimitPg(sql, "1.2.3.4", "login")
    const after = Date.now()

    // key appears twice in query, windowStart is the third interpolated value
    const windowStart = sql.calls[0].values[2] as Date
    expect(windowStart).toBeInstanceOf(Date)
    const windowMs = RATE_LIMIT_CONFIGS.login.windowMs
    expect(windowStart.getTime()).toBeGreaterThanOrEqual(before - windowMs)
    expect(windowStart.getTime()).toBeLessThanOrEqual(after - windowMs)
  })
})
