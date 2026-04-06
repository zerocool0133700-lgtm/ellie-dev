/**
 * OS Auth — Cleanup Tests
 *
 * Verifies that purgeExpiredVerificationTokens and purgeExpiredSessions
 * correctly remove stale rows while preserving valid ones.
 */

import { describe, test, expect, beforeEach } from "bun:test"
import {
  purgeExpiredVerificationTokens,
  purgeExpiredSessions,
  runCleanup,
} from "../src/os-auth/cleanup"
import { randomUUID } from "crypto"

// ── Time helpers ───────────────────────────────────────────

const hours = (n: number) => n * 60 * 60 * 1000
const days = (n: number) => n * 24 * hours(1)

function ago(ms: number): Date {
  return new Date(Date.now() - ms)
}

function future(ms: number): Date {
  return new Date(Date.now() + ms)
}

// ── In-memory SQL mock ─────────────────────────────────────

interface MockStore {
  tokens: any[]
  sessions: any[]
}

function createMockSql() {
  const store: MockStore = {
    tokens: [],
    sessions: [],
  }

  function sql(strings: TemplateStringsArray, ..._values: unknown[]): any {
    const text = strings.join("").toLowerCase()

    // DELETE FROM os_email_verification_tokens ... RETURNING id
    if (text.includes("delete from os_email_verification_tokens")) {
      const now = new Date()
      const sevenDaysAgo = new Date(now.getTime() - days(7))
      const deleted: any[] = []
      store.tokens = store.tokens.filter((t) => {
        const expired = t.expires_at < now
        const consumedOld = t.consumed_at !== null && t.consumed_at < sevenDaysAgo
        if (expired || consumedOld) {
          deleted.push({ id: t.id })
          return false
        }
        return true
      })
      return deleted
    }

    // DELETE FROM os_sessions ... RETURNING id
    if (text.includes("delete from os_sessions")) {
      const now = new Date()
      const sevenDaysAgo = new Date(now.getTime() - days(7))
      const deleted: any[] = []
      store.sessions = store.sessions.filter((s) => {
        const expired = s.expires_at < now
        const revokedOld = s.revoked_at !== null && s.revoked_at < sevenDaysAgo
        if (expired || revokedOld) {
          deleted.push({ id: s.id })
          return false
        }
        return true
      })
      return deleted
    }

    return []
  }

  // Expose store for seeding
  sql._store = store
  return sql as any
}

// ── Seed helpers ───────────────────────────────────────────

function seedToken(store: MockStore, overrides: Partial<any> = {}) {
  const token = {
    id: randomUUID(),
    account_id: randomUUID(),
    token: "osev_" + randomUUID(),
    expires_at: future(hours(24)),
    consumed_at: null,
    ...overrides,
  }
  store.tokens.push(token)
  return token
}

function seedSession(store: MockStore, overrides: Partial<any> = {}) {
  const session = {
    id: randomUUID(),
    account_id: randomUUID(),
    refresh_token: "osrt_" + randomUUID(),
    expires_at: future(days(30)),
    revoked_at: null,
    ...overrides,
  }
  store.sessions.push(session)
  return session
}

// ── Tests ──────────────────────────────────────────────────

describe("OS Auth — Cleanup", () => {
  let sql: any

  beforeEach(() => {
    sql = createMockSql()
  })

  describe("purgeExpiredVerificationTokens", () => {
    test("deletes tokens past their expires_at", async () => {
      seedToken(sql._store, { expires_at: ago(hours(1)) })
      seedToken(sql._store, { expires_at: ago(days(2)) })
      // This one is still valid
      const valid = seedToken(sql._store, { expires_at: future(hours(12)) })

      const count = await purgeExpiredVerificationTokens(sql)

      expect(count).toBe(2)
      expect(sql._store.tokens).toHaveLength(1)
      expect(sql._store.tokens[0].id).toBe(valid.id)
    })

    test("deletes consumed tokens older than 7 days", async () => {
      seedToken(sql._store, { consumed_at: ago(days(8)), expires_at: future(hours(1)) })
      seedToken(sql._store, { consumed_at: ago(days(10)), expires_at: future(hours(1)) })
      // Consumed recently — should stay
      const recent = seedToken(sql._store, { consumed_at: ago(days(1)), expires_at: future(hours(1)) })

      const count = await purgeExpiredVerificationTokens(sql)

      expect(count).toBe(2)
      expect(sql._store.tokens).toHaveLength(1)
      expect(sql._store.tokens[0].id).toBe(recent.id)
    })

    test("preserves valid unconsumed tokens", async () => {
      seedToken(sql._store, { expires_at: future(hours(24)) })
      seedToken(sql._store, { expires_at: future(hours(6)) })

      const count = await purgeExpiredVerificationTokens(sql)

      expect(count).toBe(0)
      expect(sql._store.tokens).toHaveLength(2)
    })

    test("returns 0 when no tokens exist", async () => {
      const count = await purgeExpiredVerificationTokens(sql)
      expect(count).toBe(0)
    })
  })

  describe("purgeExpiredSessions", () => {
    test("deletes sessions past their expires_at", async () => {
      seedSession(sql._store, { expires_at: ago(hours(1)) })
      seedSession(sql._store, { expires_at: ago(days(5)) })
      // Still valid
      const valid = seedSession(sql._store, { expires_at: future(days(30)) })

      const count = await purgeExpiredSessions(sql)

      expect(count).toBe(2)
      expect(sql._store.sessions).toHaveLength(1)
      expect(sql._store.sessions[0].id).toBe(valid.id)
    })

    test("deletes sessions revoked more than 7 days ago", async () => {
      seedSession(sql._store, { revoked_at: ago(days(8)) })
      seedSession(sql._store, { revoked_at: ago(days(14)) })
      // Revoked recently — should stay
      const recent = seedSession(sql._store, { revoked_at: ago(days(2)) })

      const count = await purgeExpiredSessions(sql)

      expect(count).toBe(2)
      expect(sql._store.sessions).toHaveLength(1)
      expect(sql._store.sessions[0].id).toBe(recent.id)
    })

    test("preserves valid active sessions", async () => {
      seedSession(sql._store, { expires_at: future(days(30)) })
      seedSession(sql._store, { expires_at: future(days(15)) })

      const count = await purgeExpiredSessions(sql)

      expect(count).toBe(0)
      expect(sql._store.sessions).toHaveLength(2)
    })

    test("returns 0 when no sessions exist", async () => {
      const count = await purgeExpiredSessions(sql)
      expect(count).toBe(0)
    })
  })

  describe("runCleanup", () => {
    test("purges both tokens and sessions, returns counts", async () => {
      // 2 expired tokens, 1 valid
      seedToken(sql._store, { expires_at: ago(hours(1)) })
      seedToken(sql._store, { consumed_at: ago(days(10)), expires_at: future(hours(1)) })
      seedToken(sql._store, { expires_at: future(hours(24)) })

      // 1 expired session, 1 revoked old, 1 valid
      seedSession(sql._store, { expires_at: ago(days(1)) })
      seedSession(sql._store, { revoked_at: ago(days(9)) })
      seedSession(sql._store, { expires_at: future(days(30)) })

      const result = await runCleanup(sql)

      expect(result.tokens).toBe(2)
      expect(result.sessions).toBe(2)
      expect(sql._store.tokens).toHaveLength(1)
      expect(sql._store.sessions).toHaveLength(1)
    })
  })
})
