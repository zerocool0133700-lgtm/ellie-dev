import { describe, test, expect, beforeEach } from "bun:test"
import { checkRateLimitRedis, RATE_LIMIT_CONFIGS } from "../src/os-auth/rate-limit"

// ── Mock Redis ────────────────────────────────────────────────

interface SortedSetEntry { score: number; member: string }

function createMockRedis() {
  const store = new Map<string, SortedSetEntry[]>()
  const ttls = new Map<string, number>()

  // Track multi/exec pipeline
  let pipeline: Array<{ cmd: string; args: any[] }> = []
  let inMulti = false

  const execPipeline = () => {
    const results: [Error | null, any][] = []
    for (const { cmd, args } of pipeline) {
      try {
        results.push([null, executeCommand(cmd, args)])
      } catch (err: any) {
        results.push([err, null])
      }
    }
    pipeline = []
    inMulti = false
    return results
  }

  const executeCommand = (cmd: string, args: any[]): any => {
    switch (cmd) {
      case "zremrangebyscore": {
        const [key, min, max] = args
        const entries = store.get(key) ?? []
        const filtered = entries.filter(e => e.score < min || e.score > max)
        const removed = entries.length - filtered.length
        store.set(key, filtered)
        return removed
      }
      case "zadd": {
        const [key, score, member] = args
        const entries = store.get(key) ?? []
        entries.push({ score, member })
        store.set(key, entries)
        return 1
      }
      case "zcard": {
        const [key] = args
        return (store.get(key) ?? []).length
      }
      case "pexpire": {
        const [key, ms] = args
        ttls.set(key, ms)
        return 1
      }
      default:
        throw new Error(`Unmocked command: ${cmd}`)
    }
  }

  const chainable = () => {
    const chain: any = {}
    for (const cmd of ["zremrangebyscore", "zadd", "zcard", "pexpire"]) {
      chain[cmd] = (...args: any[]) => {
        pipeline.push({ cmd, args })
        return chain
      }
    }
    chain.exec = async () => execPipeline()
    return chain
  }

  const redis: any = {
    multi: () => chainable(),
    zrange: async (key: string, start: number, stop: number, withScores?: string) => {
      const entries = store.get(key) ?? []
      const sorted = [...entries].sort((a, b) => a.score - b.score)
      const slice = sorted.slice(start, stop + 1)
      if (withScores === "WITHSCORES") {
        return slice.flatMap(e => [e.member, String(e.score)])
      }
      return slice.map(e => e.member)
    },
    _store: store,
    _ttls: ttls,
  }

  return redis
}

// ── Tests ──────────────────────────────────────────────────────

describe("checkRateLimitRedis — allows under limit", () => {
  let redis: any

  beforeEach(() => {
    redis = createMockRedis()
  })

  test("allows first request", async () => {
    const result = await checkRateLimitRedis(redis, "1.2.3.4", "login")
    expect(result.allowed).toBe(true)
    expect(result.retryAfter).toBeUndefined()
  })

  test("allows requests up to maxRequests", async () => {
    for (let i = 0; i < 10; i++) {
      const result = await checkRateLimitRedis(redis, "1.2.3.4", "login")
      expect(result.allowed).toBe(true)
    }
  })

  test("uses correct Redis key format", async () => {
    await checkRateLimitRedis(redis, "10.0.0.1", "register")
    expect(redis._store.has("os:rl:register:10.0.0.1")).toBe(true)
  })

  test("treats null IP as 'unknown'", async () => {
    await checkRateLimitRedis(redis, null, "login")
    expect(redis._store.has("os:rl:login:unknown")).toBe(true)
  })
})

describe("checkRateLimitRedis — blocks over limit", () => {
  let redis: any

  beforeEach(() => {
    redis = createMockRedis()
  })

  test("blocks after exceeding maxRequests", async () => {
    // Fill up to max (10 for login)
    for (let i = 0; i < 10; i++) {
      await checkRateLimitRedis(redis, "1.2.3.4", "login")
    }
    // 11th should be blocked
    const result = await checkRateLimitRedis(redis, "1.2.3.4", "login")
    expect(result.allowed).toBe(false)
    expect(result.retryAfter).toBeGreaterThanOrEqual(1)
  })

  test("blocks register after 5 requests", async () => {
    for (let i = 0; i < 5; i++) {
      await checkRateLimitRedis(redis, "1.2.3.4", "register")
    }
    const result = await checkRateLimitRedis(redis, "1.2.3.4", "register")
    expect(result.allowed).toBe(false)
  })

  test("blocks verify-email after 10 requests", async () => {
    for (let i = 0; i < 10; i++) {
      await checkRateLimitRedis(redis, "1.2.3.4", "verify-email")
    }
    const result = await checkRateLimitRedis(redis, "1.2.3.4", "verify-email")
    expect(result.allowed).toBe(false)
  })
})

describe("checkRateLimitRedis — per-IP isolation", () => {
  test("different IPs have independent limits", async () => {
    const redis = createMockRedis()

    // Exhaust IP A
    for (let i = 0; i < 5; i++) {
      await checkRateLimitRedis(redis, "10.0.0.1", "register")
    }
    const blocked = await checkRateLimitRedis(redis, "10.0.0.1", "register")
    expect(blocked.allowed).toBe(false)

    // IP B is fine
    const allowed = await checkRateLimitRedis(redis, "10.0.0.2", "register")
    expect(allowed.allowed).toBe(true)
  })
})

describe("checkRateLimitRedis — custom config", () => {
  test("respects custom maxRequests", async () => {
    const redis = createMockRedis()
    for (let i = 0; i < 2; i++) {
      await checkRateLimitRedis(redis, "1.2.3.4", "login", { maxRequests: 2, windowMs: 60_000 })
    }
    const result = await checkRateLimitRedis(redis, "1.2.3.4", "login", { maxRequests: 2, windowMs: 60_000 })
    expect(result.allowed).toBe(false)
  })
})

describe("checkRateLimitRedis — TTL is set", () => {
  test("sets pexpire on the key", async () => {
    const redis = createMockRedis()
    await checkRateLimitRedis(redis, "1.2.3.4", "login")
    const ttl = redis._ttls.get("os:rl:login:1.2.3.4")
    expect(ttl).toBe(RATE_LIMIT_CONFIGS.login.windowMs)
  })
})

describe("checkRateLimitRedis — pipeline failure", () => {
  test("throws when pipeline returns null", async () => {
    const redis: any = {
      multi: () => ({
        zremrangebyscore: () => redis.multi(),
        zadd: () => redis.multi(),
        zcard: () => redis.multi(),
        pexpire: () => redis.multi(),
        exec: async () => null,
      }),
    }
    await expect(checkRateLimitRedis(redis, "1.2.3.4", "login")).rejects.toThrow("pipeline returned null")
  })
})
