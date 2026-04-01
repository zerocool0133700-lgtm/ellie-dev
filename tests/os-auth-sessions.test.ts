import { describe, test, expect, mock } from "bun:test"

// Mock audit writes (fire-and-forget, not under test here)
mock.module("../src/os-auth/audit", () => ({
  writeAudit: async () => {},
  AUDIT_EVENTS: {
    TOKEN_FAMILY_REVOKED: "token_family_revoked",
  },
}))
// Mock token generation so we get a predictable value
mock.module("../src/os-auth/tokens", () => ({
  generateRefreshToken: () => "new-refresh-token",
}))

import {
  buildNewSession,
  isSessionExpired,
  isSessionRevoked,
  rotateRefreshToken,
  REFRESH_TOKEN_EXPIRY_DAYS,
} from "../src/os-auth/sessions"

describe("os-auth sessions — pure helpers", () => {
  test("buildNewSession creates session with token family and expiry", () => {
    const session = buildNewSession({
      accountId: "acc-1",
      refreshToken: "osrt_abc123",
      audience: ["life"],
      ipAddress: "192.168.1.1",
      userAgent: "TestAgent/1.0",
    })

    expect(session.account_id).toBe("acc-1")
    expect(session.refresh_token).toBe("osrt_abc123")
    expect(session.token_family).toBeDefined()
    expect(typeof session.token_family).toBe("string")
    expect(session.audience).toEqual(["life"])
    expect(session.ip_address).toBe("192.168.1.1")
    expect(session.user_agent).toBe("TestAgent/1.0")
    expect(session.revoked_at).toBeNull()

    // Expiry should be ~30 days from now
    const expectedExpiry = Date.now() + REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000
    const diff = Math.abs(session.expires_at.getTime() - expectedExpiry)
    expect(diff).toBeLessThan(5000) // within 5 seconds
  })

  test("buildNewSession with explicit token_family (rotation)", () => {
    const session = buildNewSession({
      accountId: "acc-1",
      refreshToken: "osrt_new",
      audience: ["life"],
      tokenFamily: "family-uuid-123",
    })

    expect(session.token_family).toBe("family-uuid-123")
  })

  test("isSessionExpired returns true for past expiry", () => {
    const session = { expires_at: new Date(Date.now() - 1000), revoked_at: null }
    expect(isSessionExpired(session)).toBe(true)
  })

  test("isSessionExpired returns false for future expiry", () => {
    const session = { expires_at: new Date(Date.now() + 60000), revoked_at: null }
    expect(isSessionExpired(session)).toBe(false)
  })

  test("isSessionRevoked returns true when revoked_at is set", () => {
    expect(isSessionRevoked({ revoked_at: new Date() })).toBe(true)
  })

  test("isSessionRevoked returns false when revoked_at is null", () => {
    expect(isSessionRevoked({ revoked_at: null })).toBe(false)
  })
})

// ── rotateRefreshToken transaction tests ────────────────────────────────────

/**
 * Build a minimal mock sql object that simulates postgres.js tagged-template calls
 * and sql.begin() transaction wrapping.
 *
 * The mock records which queries were executed so tests can assert ordering and
 * atomicity without a real database.
 */
function buildMockSql(opts: {
  /** Rows returned for SELECT (findSessionByRefreshToken) */
  sessionRow?: Record<string, unknown> | null
  /** Whether the INSERT inside the transaction should throw */
  insertThrows?: boolean
}) {
  const executedQueries: string[] = []
  let transactionAborted = false

  // We track revoked_at mutations applied by UPDATE calls
  let revokedAt: Date | null = null

  const makeQueryFn = (isInsideTx: boolean) => {
    const fn = (strings: TemplateStringsArray, ..._values: unknown[]) => {
      const sql = strings.join("?").trim()
      executedQueries.push(sql)

      if (sql.includes("SELECT")) {
        return opts.sessionRow ? [opts.sessionRow] : []
      }
      if (sql.includes("UPDATE")) {
        revokedAt = new Date()
        return { count: 1 }
      }
      if (sql.includes("INSERT")) {
        if (opts.insertThrows) {
          throw new Error("simulated INSERT failure")
        }
        // Return a minimal OsSession-shaped row
        return [{
          id: "new-session-id",
          account_id: "acc-1",
          refresh_token: "new-refresh-token",
          token_family: opts.sessionRow?.token_family ?? "family-1",
          audience: ["life"],
          ip_address: null,
          user_agent: null,
          expires_at: new Date(Date.now() + 30 * 86400_000),
          revoked_at: null,
          created_at: new Date(),
        }]
      }
      return []
    }
    fn.array = (v: unknown[]) => v
    return fn
  }

  const txFn = makeQueryFn(true)

  const sqlFn = makeQueryFn(false) as any
  sqlFn.begin = async (cb: (tx: any) => unknown) => {
    try {
      return await cb(txFn)
    } catch (err) {
      transactionAborted = true
      throw err
    }
  }

  return { sql: sqlFn, executedQueries, getRevokedAt: () => revokedAt, wasAborted: () => transactionAborted }
}

describe("rotateRefreshToken — transaction wrapping", () => {
  const validSession = {
    id: "session-1",
    account_id: "acc-1",
    refresh_token: "old-refresh-token",
    token_family: "family-1",
    audience: ["life"],
    ip_address: null,
    user_agent: null,
    expires_at: new Date(Date.now() + 30 * 86400_000),
    revoked_at: null,
    created_at: new Date(),
  }

  test("returns new session on successful rotation", async () => {
    const { sql } = buildMockSql({ sessionRow: validSession })

    const result = await rotateRefreshToken(sql, "old-refresh-token")

    expect(result.replayDetected).toBe(false)
    expect(result.session).not.toBeNull()
    expect(result.session?.refresh_token).toBe("new-refresh-token")
  })

  test("transaction is aborted when INSERT fails — revoke does not persist", async () => {
    const { sql, wasAborted } = buildMockSql({ sessionRow: validSession, insertThrows: true })

    await expect(rotateRefreshToken(sql, "old-refresh-token")).rejects.toThrow("simulated INSERT failure")
    expect(wasAborted()).toBe(true)
  })

  test("returns null with no replay flag when token is not found", async () => {
    const { sql } = buildMockSql({ sessionRow: null })

    const result = await rotateRefreshToken(sql, "nonexistent-token")

    expect(result.session).toBeNull()
    expect(result.replayDetected).toBe(false)
  })

  test("returns null with replayDetected=true for already-revoked token", async () => {
    const revokedSession = { ...validSession, revoked_at: new Date(Date.now() - 1000) }
    const { sql } = buildMockSql({ sessionRow: revokedSession })

    const result = await rotateRefreshToken(sql, "old-refresh-token")

    expect(result.session).toBeNull()
    expect(result.replayDetected).toBe(true)
  })

  test("returns null when session is expired", async () => {
    const expiredSession = { ...validSession, expires_at: new Date(Date.now() - 1000) }
    const { sql } = buildMockSql({ sessionRow: expiredSession })

    const result = await rotateRefreshToken(sql, "old-refresh-token")

    expect(result.session).toBeNull()
    expect(result.replayDetected).toBe(false)
  })
})
