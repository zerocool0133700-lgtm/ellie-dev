/**
 * OS Auth — Integration Tests
 *
 * Exercises the full auth lifecycle through handleOsAuthRoute() with a
 * stateful in-memory SQL mock. Real crypto throughout: argon2 hashing,
 * RS256 key generation, JWT signing/verification.
 *
 * Ticket: ELLIE-1248
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { handleOsAuthRoute, _resetKeyCache, _resetRateLimits } from "../src/os-auth/index"
import { randomUUID } from "crypto"

// ── Helpers: mock request / response ────────────────────────

function mockReq(body?: any, headers?: Record<string, string>): any {
  return { body, headers: headers ?? {} }
}

function mockRes() {
  let statusCode = 200
  let jsonBody: any = null
  let responseHeaders: Record<string, string> = {}
  return {
    status(code: number) { statusCode = code; return this },
    json(body: any) { jsonBody = body },
    setHeader(key: string, value: string) { responseHeaders[key] = value },
    getStatus: () => statusCode,
    getJson: () => jsonBody,
    getHeaders: () => responseHeaders,
  }
}

// ── Stateful SQL Mock ───────────────────────────────────────

interface TableStore {
  os_accounts: any[]
  os_auth_methods: any[]
  os_email_verification_tokens: any[]
  os_sessions: any[]
  os_product_memberships: any[]
  os_audit_log: any[]
  os_rate_limits: any[]
}

function createStatefulSql(): any {
  const tables: TableStore = {
    os_accounts: [],
    os_auth_methods: [],
    os_email_verification_tokens: [],
    os_sessions: [],
    os_product_memberships: [],
    os_audit_log: [],
    os_rate_limits: [],
  }

  /** Parse a SQL tagged template into a single string + interpolated values. */
  function extractSql(strings: TemplateStringsArray, values: unknown[]): { text: string; vals: unknown[] } {
    let text = ""
    for (let i = 0; i < strings.length; i++) {
      text += strings[i]
      if (i < values.length) text += `$${i + 1}`
    }
    return { text: text.trim(), vals: values }
  }

  /** Identify which table a SQL statement targets. */
  function findTable(text: string): keyof TableStore | null {
    const tableNames: (keyof TableStore)[] = [
      "os_email_verification_tokens",
      "os_product_memberships",
      "os_rate_limits",
      "os_auth_methods",
      "os_audit_log",
      "os_accounts",
      "os_sessions",
    ]
    const lower = text.toLowerCase()
    for (const t of tableNames) {
      if (lower.includes(t)) return t
    }
    return null
  }

  /** The core tagged-template handler. */
  function sql(strings: TemplateStringsArray, ...values: unknown[]): any {
    const { text, vals } = extractSql(strings, values)
    const lower = text.toLowerCase()
    const table = findTable(text)

    // ── Rate limit CTE (WITH inserted AS ... INSERT INTO os_rate_limits ...) ─
    if (lower.startsWith("with") && table === "os_rate_limits") {
      const key = vals[0] as string
      const windowStart = vals[2] as Date
      tables.os_rate_limits.push({ key, timestamp: new Date() })
      const recent = tables.os_rate_limits.filter(
        (r: any) => r.key === key && r.timestamp > windowStart
      )
      const oldest = recent.length > 0
        ? recent.reduce((min: any, r: any) => r.timestamp < min.timestamp ? r : min).timestamp
        : null
      return [{ cnt: String(recent.length), oldest }]
    }

    // ── INSERT ──────────────────────────────────────────────
    if (lower.startsWith("insert into") && table) {
      const row: any = { id: randomUUID(), created_at: new Date(), updated_at: new Date() }

      if (table === "os_accounts") {
        // INSERT INTO os_accounts (email, display_name, password_hash, entity_type, status)
        // VALUES ($1, $2, $3, $4, 'pending_verification')
        // Note: status is a SQL literal, not an interpolated value — only 4 $-params
        row.email = vals[0]
        row.display_name = vals[1]
        row.password_hash = vals[2]
        row.entity_type = vals[3]
        row.status = "pending_verification"
        row.email_verified = false
        row.mfa_enabled = false
        row.mfa_secret = null
        row.deleted_at = null

        // Check unique constraint on email
        if (tables.os_accounts.some(a => a.email === row.email)) {
          const err: any = new Error("unique_violation")
          err.code = "23505"
          throw err
        }

        tables.os_accounts.push(row)
        const result = [row]
        result.count = 1
        return result
      }

      if (table === "os_auth_methods") {
        row.account_id = vals[0]
        row.method = vals[1]
        row.provider_uid = null
        row.metadata = {}
        tables.os_auth_methods.push(row)
        const result = [row]
        result.count = 1
        return result
      }

      if (table === "os_email_verification_tokens") {
        row.account_id = vals[0]
        row.token = vals[1]
        row.expires_at = vals[2]
        row.consumed_at = null
        tables.os_email_verification_tokens.push(row)
        const result = [row]
        result.count = 1
        return result
      }

      if (table === "os_sessions") {
        row.account_id = vals[0]
        row.refresh_token = vals[1]
        row.token_family = vals[2]
        row.audience = vals[3] // Already an array from sql.array()
        // vals[4] is ip_address — the SQL template includes a ::inet cast in the
        // text, but that's irrelevant for in-memory storage; we store the raw value.
        row.ip_address = vals[4]
        row.user_agent = vals[5]
        row.expires_at = vals[6]
        row.revoked_at = null
        tables.os_sessions.push(row)
        const result = [row]
        result.count = 1
        return result
      }

      if (table === "os_audit_log") {
        row.account_id = vals[0]
        row.event_type = vals[1]
        row.product = vals[2]
        row.ip_address = vals[3]
        row.user_agent = vals[4]
        row.metadata = vals[5]
        tables.os_audit_log.push(row)
        const result = [row]
        result.count = 1
        return result
      }

      if (table === "os_product_memberships") {
        row.account_id = vals[0]
        row.product = vals[1]
        row.roles = vals[2]
        row.entitlements = vals[3]
        row.org_id = vals[4]
        row.status = "active"
        tables.os_product_memberships.push(row)
        const result = [row]
        result.count = 1
        return result
      }

      // Fallback: no-op insert
      const result: any[] = []
      result.count = 0
      return result
    }

    // ── UPDATE ... RETURNING (verification token consume) ───
    if (lower.startsWith("update") && table === "os_email_verification_tokens" && lower.includes("returning")) {
      const token = vals[0]
      const row = tables.os_email_verification_tokens.find(
        (t: any) => t.token === token && !t.consumed_at && t.expires_at > new Date()
      )
      if (row) {
        row.consumed_at = new Date()
        const result = [row]
        result.count = 1
        return result
      }
      const result: any[] = []
      result.count = 0
      return result
    }

    // ── UPDATE os_accounts (verify email) ───────────────────
    if (lower.startsWith("update") && table === "os_accounts") {
      // UPDATE os_accounts SET email_verified = true, status = 'active' WHERE id = $1 AND status = 'pending_verification'
      const accountId = vals[0]
      const account = tables.os_accounts.find(
        (a: any) => a.id === accountId && a.status === "pending_verification"
      )
      if (account) {
        account.email_verified = true
        account.status = "active"
        account.updated_at = new Date()
        const result: any[] = []
        result.count = 1
        return result
      }
      const result: any[] = []
      result.count = 0
      return result
    }

    // ── UPDATE os_sessions SET revoked_at ────────────────────
    // Discriminated by WHERE clause keyword (table-driven, not SQL-text-driven):
    //   WHERE id = $1            → revoke single session (logout single)
    //   WHERE token_family = $1  → revoke entire family (replay detection)
    //   WHERE account_id = $1   → revoke all sessions for account (logout all)
    if (lower.startsWith("update") && table === "os_sessions") {
      // Revoke by ID: WHERE id = $1
      if (lower.includes("where id =")) {
        const sessionId = vals[0]
        const session = tables.os_sessions.find((s: any) => s.id === sessionId)
        if (session) {
          session.revoked_at = new Date()
          const result: any[] = []
          result.count = 1
          return result
        }
        const result: any[] = []
        result.count = 0
        return result
      }
      // Revoke by token_family: WHERE token_family = $1 AND revoked_at IS NULL
      if (lower.includes("token_family")) {
        const family = vals[0]
        let count = 0
        for (const s of tables.os_sessions) {
          if (s.token_family === family && !s.revoked_at) {
            s.revoked_at = new Date()
            count++
          }
        }
        const result: any[] = []
        result.count = count
        return result
      }
      // Revoke by account_id: WHERE account_id = $1 AND revoked_at IS NULL
      if (lower.includes("account_id")) {
        const accountId = vals[0]
        let count = 0
        for (const s of tables.os_sessions) {
          if (s.account_id === accountId && !s.revoked_at) {
            s.revoked_at = new Date()
            count++
          }
        }
        const result: any[] = []
        result.count = count
        return result
      }
      const result: any[] = []
      result.count = 0
      return result
    }

    // ── SELECT ──────────────────────────────────────────────
    if (lower.startsWith("select")) {
      if (table === "os_accounts") {
        // SELECT * FROM os_accounts WHERE email = $1 AND status != 'deleted'
        if (lower.includes("where email")) {
          const email = vals[0]
          const rows = tables.os_accounts.filter(
            (a: any) => a.email === email && a.status !== "deleted"
          )
          const result: any = rows
          result.count = rows.length
          return result
        }
        // SELECT ... FROM os_accounts WHERE id = $1
        // Both /me (full account + memberships) and /refresh (account lookup) hit this branch
        // with different column projections, but the mock returns the full row which covers both.
        if (lower.includes("where id")) {
          const id = vals[0]
          const rows = tables.os_accounts.filter((a: any) => a.id === id)
          const result: any = rows
          result.count = rows.length
          return result
        }
      }

      if (table === "os_email_verification_tokens") {
        // SELECT consumed_at, expires_at FROM os_email_verification_tokens WHERE token = $1
        const token = vals[0]
        const rows = tables.os_email_verification_tokens.filter(
          (t: any) => t.token === token
        )
        const result: any = rows
        result.count = rows.length
        return result
      }

      if (table === "os_product_memberships") {
        const accountId = vals[0]
        const rows = tables.os_product_memberships.filter(
          (m: any) => m.account_id === accountId && m.status === "active"
        )
        const result: any = rows
        result.count = rows.length
        return result
      }

      if (table === "os_sessions") {
        // SELECT * FROM os_sessions WHERE refresh_token = $1
        const refreshToken = vals[0]
        const rows = tables.os_sessions.filter(
          (s: any) => s.refresh_token === refreshToken
        )
        const result: any = rows
        result.count = rows.length
        return result
      }
    }

    // Fallback
    const result: any[] = []
    result.count = 0
    return result
  }

  // sql.begin() — transaction support
  sql.begin = async (cb: (tx: any) => unknown) => cb(sql)

  // sql.array() — used for audience arrays in session INSERT
  sql.array = (values: unknown[]) => values

  // Expose tables for test inspection
  sql._tables = tables

  return sql
}

// ── Mock deps factory ───────────────────────────────────────

function createDeps(sql: any) {
  const secrets = new Map<string, string>()
  return {
    sql,
    retrieveSecret: async (keychainId: string, key: string) => secrets.get(`${keychainId}:${key}`) ?? null,
    storeSecret: async (keychainId: string, key: string, value: string) => { secrets.set(`${keychainId}:${key}`, value) },
  }
}

// ── Helper to seed a membership ─────────────────────────────

function seedMembership(sql: any, accountId: string, product: string, roles: string[] = ["member"]) {
  sql._tables.os_product_memberships.push({
    id: randomUUID(),
    account_id: accountId,
    product,
    roles,
    entitlements: {},
    org_id: null,
    status: "active",
    created_at: new Date(),
    updated_at: new Date(),
  })
}

// ── Tests ───────────────────────────────────────────────────

describe("OS Auth — Integration Tests", () => {
  let sql: any
  let deps: any

  beforeEach(() => {
    _resetKeyCache()
    _resetRateLimits()
    sql = createStatefulSql()
    deps = createDeps(sql)
  })

  afterEach(() => {
    _resetKeyCache()
    _resetRateLimits()
  })

  // ── 1. Happy Path: register → verify-email → login → /me → refresh → logout ──

  describe("happy path: full lifecycle", () => {
    test("register → verify-email → login → /me → refresh → logout", async () => {
      // --- REGISTER ---
      const regRes = mockRes()
      await handleOsAuthRoute(
        mockReq({ email: "dave@example.com", password: "securePass99", display_name: "Dave" }),
        regRes,
        "/api/os-auth/register",
        "POST",
        deps,
      )
      expect(regRes.getStatus()).toBe(201)
      const regBody = regRes.getJson()
      expect(regBody.ok).toBe(true)
      expect(regBody.account.email).toBe("dave@example.com")
      expect(regBody.account.status).toBe("pending_verification")
      const accountId = regBody.account.id

      // Grab the verification token from in-memory store
      const verToken = sql._tables.os_email_verification_tokens[0]?.token
      expect(verToken).toBeTruthy()

      // --- VERIFY EMAIL ---
      const verRes = mockRes()
      await handleOsAuthRoute(
        mockReq({ token: verToken }),
        verRes,
        "/api/os-auth/verify-email",
        "POST",
        deps,
      )
      expect(verRes.getStatus()).toBe(200)
      expect(verRes.getJson().ok).toBe(true)

      // Account should now be active
      const acct = sql._tables.os_accounts[0]
      expect(acct.status).toBe("active")
      expect(acct.email_verified).toBe(true)

      // Seed a membership for the "life" product
      seedMembership(sql, accountId, "life", ["owner"])

      // --- LOGIN ---
      const loginRes = mockRes()
      await handleOsAuthRoute(
        mockReq({ email: "dave@example.com", password: "securePass99", audience: "life" }),
        loginRes,
        "/api/os-auth/login",
        "POST",
        deps,
      )
      expect(loginRes.getStatus()).toBe(200)
      const loginBody = loginRes.getJson()
      expect(loginBody.ok).toBe(true)
      expect(loginBody.access_token).toBeTruthy()
      expect(loginBody.refresh_token).toBeTruthy()
      expect(loginBody.account.id).toBe(accountId)

      const accessToken = loginBody.access_token
      const refreshToken = loginBody.refresh_token

      // --- GET /me ---
      const meRes = mockRes()
      await handleOsAuthRoute(
        mockReq(undefined, { authorization: `Bearer ${accessToken}` }),
        meRes,
        "/api/os-auth/me",
        "GET",
        deps,
      )
      expect(meRes.getStatus()).toBe(200)
      const meBody = meRes.getJson()
      expect(meBody.ok).toBe(true)
      expect(meBody.account.email).toBe("dave@example.com")
      expect(meBody.account.status).toBe("active")
      expect(meBody.memberships).toBeDefined()

      // --- REFRESH ---
      const refreshRes = mockRes()
      await handleOsAuthRoute(
        mockReq({ refresh_token: refreshToken }),
        refreshRes,
        "/api/os-auth/refresh",
        "POST",
        deps,
      )
      expect(refreshRes.getStatus()).toBe(200)
      const refreshBody = refreshRes.getJson()
      expect(refreshBody.ok).toBe(true)
      expect(refreshBody.access_token).toBeTruthy()
      expect(refreshBody.refresh_token).toBeTruthy()
      // New refresh token should differ from old
      expect(refreshBody.refresh_token).not.toBe(refreshToken)

      // --- LOGOUT (single session) ---
      const logoutRes = mockRes()
      await handleOsAuthRoute(
        mockReq({ refresh_token: refreshBody.refresh_token }),
        logoutRes,
        "/api/os-auth/logout",
        "POST",
        deps,
      )
      expect(logoutRes.getStatus()).toBe(200)
      expect(logoutRes.getJson().ok).toBe(true)
    })
  })

  // ── 2. Token Rotation ────────────────────────────────────────

  describe("token rotation", () => {
    test("refresh rotates token; old refresh token is rejected", async () => {
      // Register + verify + login
      const { accessToken, refreshToken, accountId } = await registerVerifyLogin(sql, deps)

      // First refresh — should succeed
      const r1 = mockRes()
      await handleOsAuthRoute(
        mockReq({ refresh_token: refreshToken }),
        r1,
        "/api/os-auth/refresh",
        "POST",
        deps,
      )
      expect(r1.getStatus()).toBe(200)
      const newRefresh = r1.getJson().refresh_token
      expect(newRefresh).not.toBe(refreshToken)

      // Try the OLD refresh token — it was revoked, should fail
      const r2 = mockRes()
      await handleOsAuthRoute(
        mockReq({ refresh_token: refreshToken }),
        r2,
        "/api/os-auth/refresh",
        "POST",
        deps,
      )
      // Old token is revoked, triggers replay detection
      expect(r2.getStatus()).toBe(401)
      expect(r2.getJson().error).toContain("compromised")
    })
  })

  // ── 3. Token Family Reuse Detection ──────────────────────────

  describe("token family reuse detection", () => {
    test("stolen refresh token (reuse after rotation) revokes entire family", async () => {
      const { refreshToken, accountId } = await registerVerifyLogin(sql, deps)

      // Rotate once: legitimate user
      const r1 = mockRes()
      await handleOsAuthRoute(
        mockReq({ refresh_token: refreshToken }),
        r1,
        "/api/os-auth/refresh",
        "POST",
        deps,
      )
      expect(r1.getStatus()).toBe(200)
      const legitimateRefresh = r1.getJson().refresh_token

      // Attacker tries to use the OLD (stolen) refresh token
      const attackerRes = mockRes()
      await handleOsAuthRoute(
        mockReq({ refresh_token: refreshToken }),
        attackerRes,
        "/api/os-auth/refresh",
        "POST",
        deps,
      )
      expect(attackerRes.getStatus()).toBe(401)
      expect(attackerRes.getJson().error).toContain("compromised")

      // Now the legitimate user's new refresh token should ALSO be revoked
      // (entire family was revoked)
      const victimRes = mockRes()
      await handleOsAuthRoute(
        mockReq({ refresh_token: legitimateRefresh }),
        victimRes,
        "/api/os-auth/refresh",
        "POST",
        deps,
      )
      expect(victimRes.getStatus()).toBe(401)
    })
  })

  // ── 4. Rate Limiting ─────────────────────────────────────────

  describe("rate limiting", () => {
    test("returns 429 after register threshold (5 requests)", async () => {
      // The register endpoint allows 5 requests per 15 min window
      for (let i = 0; i < 5; i++) {
        const res = mockRes()
        await handleOsAuthRoute(
          mockReq({ email: `user${i}@example.com`, password: "password123" }, { "x-forwarded-for": "10.0.0.1" }),
          res,
          "/api/os-auth/register",
          "POST",
          deps,
        )
        // These may succeed or fail on unique, but rate limit should still allow them
        expect(res.getStatus()).not.toBe(429)
      }

      // 6th request should be rate-limited
      const res = mockRes()
      await handleOsAuthRoute(
        mockReq({ email: "user99@example.com", password: "password123" }, { "x-forwarded-for": "10.0.0.1" }),
        res,
        "/api/os-auth/register",
        "POST",
        deps,
      )
      expect(res.getStatus()).toBe(429)
      expect(res.getJson().retryAfter).toBeGreaterThan(0)
      expect(res.getHeaders()["Retry-After"]).toBeTruthy()
    })

    test("returns 429 after login threshold (10 requests)", async () => {
      // All 10 requests return 401 (account doesn't exist) — intentional.
      // The rate limiter counts every attempt regardless of auth outcome,
      // so failed logins still consume quota and trigger the 429 on the 11th.
      for (let i = 0; i < 10; i++) {
        const res = mockRes()
        await handleOsAuthRoute(
          mockReq({ email: "nobody@example.com", password: "password123" }, { "x-forwarded-for": "10.0.0.2" }),
          res,
          "/api/os-auth/login",
          "POST",
          deps,
        )
        expect(res.getStatus()).not.toBe(429)
      }

      const res = mockRes()
      await handleOsAuthRoute(
        mockReq({ email: "nobody@example.com", password: "password123" }, { "x-forwarded-for": "10.0.0.2" }),
        res,
        "/api/os-auth/login",
        "POST",
        deps,
      )
      expect(res.getStatus()).toBe(429)
    })

    test("rate limits are independent per IP", async () => {
      // Exhaust IP 10.0.0.3
      for (let i = 0; i < 5; i++) {
        const res = mockRes()
        await handleOsAuthRoute(
          mockReq({ email: `r${i}@example.com`, password: "password123" }, { "x-forwarded-for": "10.0.0.3" }),
          res,
          "/api/os-auth/register",
          "POST",
          deps,
        )
      }

      // 10.0.0.3 is blocked
      const blockedRes = mockRes()
      await handleOsAuthRoute(
        mockReq({ email: "extra@example.com", password: "password123" }, { "x-forwarded-for": "10.0.0.3" }),
        blockedRes,
        "/api/os-auth/register",
        "POST",
        deps,
      )
      expect(blockedRes.getStatus()).toBe(429)

      // Different IP is fine
      const otherRes = mockRes()
      await handleOsAuthRoute(
        mockReq({ email: "other@example.com", password: "password123" }, { "x-forwarded-for": "10.0.0.4" }),
        otherRes,
        "/api/os-auth/register",
        "POST",
        deps,
      )
      expect(otherRes.getStatus()).not.toBe(429)
    })
  })

  // ── 5. Invalid Credentials ───────────────────────────────────

  describe("invalid credentials", () => {
    test("wrong password returns 401", async () => {
      await registerVerifyLogin(sql, deps)

      const res = mockRes()
      await handleOsAuthRoute(
        mockReq({ email: "dave@example.com", password: "WRONG_PASSWORD", audience: "life" }),
        res,
        "/api/os-auth/login",
        "POST",
        deps,
      )
      expect(res.getStatus()).toBe(401)
      expect(res.getJson().error).toBe("Invalid email or password")
    })

    test("non-existent email returns 401", async () => {
      const res = mockRes()
      await handleOsAuthRoute(
        mockReq({ email: "nobody@example.com", password: "password123", audience: "life" }),
        res,
        "/api/os-auth/login",
        "POST",
        deps,
      )
      expect(res.getStatus()).toBe(401)
      expect(res.getJson().error).toBe("Invalid email or password")
    })

    test("unverified account cannot login", async () => {
      // Register but do NOT verify email
      const regRes = mockRes()
      await handleOsAuthRoute(
        mockReq({ email: "unverified@example.com", password: "password123" }),
        regRes,
        "/api/os-auth/register",
        "POST",
        deps,
      )
      expect(regRes.getStatus()).toBe(201)

      const loginRes = mockRes()
      await handleOsAuthRoute(
        mockReq({ email: "unverified@example.com", password: "password123", audience: "life" }),
        loginRes,
        "/api/os-auth/login",
        "POST",
        deps,
      )
      expect(loginRes.getStatus()).toBe(401)
      expect(loginRes.getJson().error).toBe("Please verify your email before signing in")
    })
  })

  // ── 6. Audience Scoping ──────────────────────────────────────

  describe("audience scoping", () => {
    test("/me works with matching ?audience= param", async () => {
      const { accessToken } = await registerVerifyLogin(sql, deps, "life")

      const res = mockRes()
      await handleOsAuthRoute(
        mockReq(undefined, { authorization: `Bearer ${accessToken}` }),
        res,
        "/api/os-auth/me",
        "GET",
        deps,
        new URLSearchParams({ audience: "life" }),
      )
      expect(res.getStatus()).toBe(200)
      expect(res.getJson().ok).toBe(true)
    })

    test("/me works without audience param (tries all)", async () => {
      const { accessToken } = await registerVerifyLogin(sql, deps, "life")

      const res = mockRes()
      await handleOsAuthRoute(
        mockReq(undefined, { authorization: `Bearer ${accessToken}` }),
        res,
        "/api/os-auth/me",
        "GET",
        deps,
        // No audience param
      )
      expect(res.getStatus()).toBe(200)
      expect(res.getJson().ok).toBe(true)
    })

    test("/me rejects explicit wrong audience", async () => {
      // Token was issued for "life"
      const { accessToken } = await registerVerifyLogin(sql, deps, "life")

      const res = mockRes()
      await handleOsAuthRoute(
        mockReq(undefined, { authorization: `Bearer ${accessToken}` }),
        res,
        "/api/os-auth/me",
        "GET",
        deps,
        new URLSearchParams({ audience: "learn" }),
      )
      expect(res.getStatus()).toBe(401)
      expect(res.getJson().error).toBe("Invalid or expired token")
    })

    test("/me rejects invalid audience name", async () => {
      const { accessToken } = await registerVerifyLogin(sql, deps, "life")

      const res = mockRes()
      await handleOsAuthRoute(
        mockReq(undefined, { authorization: `Bearer ${accessToken}` }),
        res,
        "/api/os-auth/me",
        "GET",
        deps,
        new URLSearchParams({ audience: "bogus" }),
      )
      expect(res.getStatus()).toBe(400)
      expect(res.getJson().error).toContain("Invalid audience")
    })
  })

  // ── 7. JWKS Endpoint ─────────────────────────────────────────

  describe("JWKS endpoint", () => {
    test("/.well-known/jwks.json returns valid JWK format", async () => {
      const res = mockRes()
      await handleOsAuthRoute(
        mockReq(),
        res,
        "/.well-known/jwks.json",
        "GET",
        deps,
      )
      expect(res.getStatus()).toBe(200)
      const body = res.getJson()
      expect(body.keys).toBeArray()
      expect(body.keys.length).toBe(1)

      const jwk = body.keys[0]
      expect(jwk.kty).toBe("RSA")
      expect(jwk.alg).toBe("RS256")
      expect(jwk.use).toBe("sig")
      expect(jwk.kid).toBeTruthy()
      expect(jwk.n).toBeTruthy() // RSA modulus
      expect(jwk.e).toBeTruthy() // RSA exponent
    })

    test("JWKS kid matches token header kid", async () => {
      // Login to generate keys, then check JWKS
      const { accessToken } = await registerVerifyLogin(sql, deps)

      const jwksRes = mockRes()
      await handleOsAuthRoute(
        mockReq(),
        jwksRes,
        "/.well-known/jwks.json",
        "GET",
        deps,
      )
      const jwk = jwksRes.getJson().keys[0]

      // Decode the JWT header to get kid
      const headerB64 = accessToken.split(".")[0]
      const header = JSON.parse(Buffer.from(headerB64, "base64url").toString())
      expect(header.kid).toBe(jwk.kid)
      expect(header.alg).toBe("RS256")
    })
  })

  // ── Bonus: Logout all sessions ───────────────────────────────

  describe("logout all sessions", () => {
    test("logout with all:true revokes all sessions for the account", async () => {
      const { accessToken, refreshToken, accountId } = await registerVerifyLogin(sql, deps)

      // Create a second session by logging in again
      _resetRateLimits() // avoid rate limit from the registerVerifyLogin calls
      const login2 = mockRes()
      await handleOsAuthRoute(
        mockReq({ email: "dave@example.com", password: "securePass99", audience: "life" }),
        login2,
        "/api/os-auth/login",
        "POST",
        deps,
      )
      expect(login2.getStatus()).toBe(200)
      const refresh2 = login2.getJson().refresh_token

      // Logout all
      const logoutRes = mockRes()
      await handleOsAuthRoute(
        mockReq({ all: true }, { authorization: `Bearer ${accessToken}` }),
        logoutRes,
        "/api/os-auth/logout",
        "POST",
        deps,
      )
      expect(logoutRes.getStatus()).toBe(200)
      expect(logoutRes.getJson().ok).toBe(true)
      expect(logoutRes.getJson().revoked).toBeGreaterThanOrEqual(2)

      // Both refresh tokens should now be rejected
      for (const rt of [refreshToken, refresh2]) {
        const res = mockRes()
        await handleOsAuthRoute(
          mockReq({ refresh_token: rt }),
          res,
          "/api/os-auth/refresh",
          "POST",
          deps,
        )
        expect(res.getStatus()).toBe(401)
      }
    })
  })
})

// ── Shared Helper: register → verify → login ────────────────

async function registerVerifyLogin(
  sql: any,
  deps: any,
  audience = "life",
): Promise<{ accessToken: string; refreshToken: string; accountId: string }> {
  const email = "dave@example.com"

  // Register — each test gets a fresh sql instance so this always yields 201
  const regRes = mockRes()
  await handleOsAuthRoute(
    mockReq({ email, password: "securePass99", display_name: "Dave" }),
    regRes,
    "/api/os-auth/register",
    "POST",
    deps,
  )
  expect(regRes.getStatus()).toBe(201)

  // Look up the account by email rather than relying on array position
  const acct = sql._tables.os_accounts.find((a: any) => a.email === email)
  const accountId = acct.id
  if (acct.status === "pending_verification") {
    const verToken = sql._tables.os_email_verification_tokens[0]?.token
    const verRes = mockRes()
    await handleOsAuthRoute(
      mockReq({ token: verToken }),
      verRes,
      "/api/os-auth/verify-email",
      "POST",
      deps,
    )
    expect(verRes.getStatus()).toBe(200)
  }

  // Seed membership
  if (!sql._tables.os_product_memberships.some((m: any) => m.account_id === accountId && m.product === audience)) {
    seedMembership(sql, accountId, audience, ["owner"])
  }

  // Login
  const loginRes = mockRes()
  await handleOsAuthRoute(
    mockReq({ email: "dave@example.com", password: "securePass99", audience }),
    loginRes,
    "/api/os-auth/login",
    "POST",
    deps,
  )
  expect(loginRes.getStatus()).toBe(200)
  const loginBody = loginRes.getJson()

  return {
    accessToken: loginBody.access_token,
    refreshToken: loginBody.refresh_token,
    accountId,
  }
}
