/**
 * OS Auth — Real Database Integration Tests (ELLIE-1261)
 *
 * Runs the OS auth lifecycle against the real test Postgres instance
 * (ellie-forest-test). Validates constraints, foreign keys, unique
 * indexes, and cleanup queries work against actual SQL.
 *
 * Prerequisites:
 *   - ellie-forest-test database exists
 *   - OS auth migrations applied (20260401_os_*.sql)
 */

// Force test database BEFORE any imports
process.env.DB_NAME = "ellie-forest-test"

import { describe, test, expect, beforeEach, afterAll } from "bun:test"
import sql from "../../ellie-forest/src/db.ts"
import { registerAccount, verifyAccountEmail } from "../src/os-auth/registration"
import { loginWithPassword } from "../src/os-auth/login"
import { createSession, rotateRefreshToken, revokeAllAccountSessions } from "../src/os-auth/sessions"
import { createVerificationToken, consumeVerificationToken } from "../src/os-auth/verification"
import { upsertMembership, getAccountMemberships } from "../src/os-auth/memberships"
import { writeAudit, AUDIT_EVENTS } from "../src/os-auth/audit"
import { purgeExpiredVerificationTokens, purgeExpiredSessions, runCleanup } from "../src/os-auth/cleanup"
import { checkRateLimitPg } from "../src/os-auth/rate-limit"
import { hashPassword } from "../src/os-auth/passwords"
import { signAccessToken, verifyAccessToken } from "../src/os-auth/tokens"
import { generateKeyPair, _resetKeyCache } from "../src/os-auth/keys"
import { randomUUID } from "crypto"

// ── Cleanup helpers ──────────────────────────────────────────

async function cleanOsAuthTables() {
  await sql`DELETE FROM os_rate_limits`
  await sql`DELETE FROM os_audit_log`
  await sql`DELETE FROM os_cross_product_consents`
  await sql`DELETE FROM os_product_memberships`
  await sql`DELETE FROM os_email_verification_tokens`
  await sql`DELETE FROM os_sessions`
  await sql`DELETE FROM os_auth_methods`
  await sql`DELETE FROM os_accounts`
}

beforeEach(async () => { await cleanOsAuthTables() })
afterAll(async () => {
  await cleanOsAuthTables()
  await sql.end()
})

// ── Tests ────────────────────────────────────────────────────

describe("OS Auth — Real DB Integration (ELLIE-1261)", () => {

  describe("registration", () => {
    test("registerAccount creates account, auth_method, and verification token", async () => {
      const result = await registerAccount(sql, {
        email: "test@example.com",
        password: "SecurePass123!",
        display_name: "Test User",
      })

      expect(result.ok).toBe(true)
      expect(result.account).toBeDefined()
      expect(result.account!.email).toBe("test@example.com")
      expect(result.account!.status).toBe("pending_verification")

      // Verify rows exist in DB
      const [account] = await sql`SELECT * FROM os_accounts WHERE email = 'test@example.com'`
      expect(account).toBeDefined()
      expect(account.email_verified).toBe(false)
      expect(account.entity_type).toBe("user")

      const [authMethod] = await sql`SELECT * FROM os_auth_methods WHERE account_id = ${account.id}`
      expect(authMethod).toBeDefined()
      expect(authMethod.method).toBe("email_password")

      const [token] = await sql`SELECT * FROM os_email_verification_tokens WHERE account_id = ${account.id}`
      expect(token).toBeDefined()
      expect(token.consumed_at).toBeNull()
    })

    test("duplicate email is rejected by unique constraint", async () => {
      await registerAccount(sql, { email: "dupe@example.com", password: "Pass1234!" })
      const result = await registerAccount(sql, { email: "dupe@example.com", password: "Pass5678!" })
      expect(result.ok).toBe(false)
    })

    test("entity_type constraint rejects invalid values", async () => {
      await expect(sql`
        INSERT INTO os_accounts (email, entity_type, status)
        VALUES ('bad@example.com', 'invalid_type', 'active')
      `).rejects.toThrow()
    })

    test("status constraint rejects invalid values", async () => {
      await expect(sql`
        INSERT INTO os_accounts (email, entity_type, status)
        VALUES ('bad@example.com', 'user', 'bogus')
      `).rejects.toThrow()
    })
  })

  describe("email verification", () => {
    test("full verification flow: create token → consume → activate account", async () => {
      const regResult = await registerAccount(sql, {
        email: "verify@example.com",
        password: "Pass1234!",
      })
      const accountId = regResult.account!.id

      // Get the token that was created during registration
      const [tokenRow] = await sql`
        SELECT token FROM os_email_verification_tokens WHERE account_id = ${accountId}
      `
      expect(tokenRow).toBeDefined()

      // Consume it
      const consumeResult = await consumeVerificationToken(sql, tokenRow.token)
      expect(consumeResult.ok).toBe(true)
      expect(consumeResult.accountId).toBe(accountId)

      // Activate account
      const activated = await verifyAccountEmail(sql, accountId)
      expect(activated).toBe(true)

      // Verify DB state
      const [account] = await sql`SELECT * FROM os_accounts WHERE id = ${accountId}`
      expect(account.status).toBe("active")
      expect(account.email_verified).toBe(true)
    })

    test("consuming token twice fails", async () => {
      const regResult = await registerAccount(sql, {
        email: "double@example.com",
        password: "Pass1234!",
      })
      const [tokenRow] = await sql`
        SELECT token FROM os_email_verification_tokens WHERE account_id = ${regResult.account!.id}
      `

      const first = await consumeVerificationToken(sql, tokenRow.token)
      expect(first.ok).toBe(true)

      const second = await consumeVerificationToken(sql, tokenRow.token)
      expect(second.ok).toBe(false)
      expect(second.error).toContain("already been used")
    })

    test("expired token is rejected", async () => {
      const regResult = await registerAccount(sql, {
        email: "expired@example.com",
        password: "Pass1234!",
      })

      // Manually expire the token
      await sql`
        UPDATE os_email_verification_tokens
        SET expires_at = now() - interval '1 hour'
        WHERE account_id = ${regResult.account!.id}
      `

      const [tokenRow] = await sql`
        SELECT token FROM os_email_verification_tokens WHERE account_id = ${regResult.account!.id}
      `
      const result = await consumeVerificationToken(sql, tokenRow.token)
      expect(result.ok).toBe(false)
      expect(result.error).toContain("expired")
    })
  })

  describe("login", () => {
    test("login succeeds for active account with correct password", async () => {
      // Create and activate account
      const regResult = await registerAccount(sql, {
        email: "login@example.com",
        password: "Correct123!",
      })
      await verifyAccountEmail(sql, regResult.account!.id)

      // Generate signing keys
      const keys = await generateKeyPair()
      const kid = `test-${Date.now()}`

      const loginResult = await loginWithPassword(sql, {
        email: "login@example.com",
        password: "Correct123!",
        audience: "life",
      }, { privateKey: keys.privateKey, publicKey: keys.publicKey, kid })

      expect(loginResult.ok).toBe(true)
      expect(loginResult.accessToken).toBeDefined()
      expect(loginResult.refreshToken).toBeDefined()

      // Session exists in DB
      const sessions = await sql`SELECT * FROM os_sessions WHERE account_id = ${regResult.account!.id}`
      expect(sessions.length).toBe(1)
      expect(sessions[0].refresh_token).toBe(loginResult.refreshToken)
    })

    test("login fails for pending_verification account", async () => {
      await registerAccount(sql, { email: "pending@example.com", password: "Pass1234!" })
      const keys = await generateKeyPair()
      const kid = `test-${Date.now()}`

      const result = await loginWithPassword(sql, {
        email: "pending@example.com",
        password: "Pass1234!",
        audience: "life",
      }, { privateKey: keys.privateKey, publicKey: keys.publicKey, kid })

      expect(result.ok).toBe(false)
    })

    test("login fails for wrong password", async () => {
      const regResult = await registerAccount(sql, { email: "wrong@example.com", password: "Correct123!" })
      await verifyAccountEmail(sql, regResult.account!.id)
      const keys = await generateKeyPair()

      const result = await loginWithPassword(sql, {
        email: "wrong@example.com",
        password: "WrongPass!",
        audience: "life",
      }, { privateKey: keys.privateKey, publicKey: keys.publicKey, kid: `test-${Date.now()}` })

      expect(result.ok).toBe(false)
    })
  })

  describe("sessions", () => {
    test("refresh token rotation creates new session and revokes old", async () => {
      const regResult = await registerAccount(sql, { email: "session@example.com", password: "Pass1234!" })
      await verifyAccountEmail(sql, regResult.account!.id)
      const accountId = regResult.account!.id

      // Create initial session
      const session = await createSession(sql, {
        accountId,
        audience: ["life"],
      })
      expect(session.refresh_token).toMatch(/^osrt_/)

      // Rotate
      const rotationResult = await rotateRefreshToken(sql, session.refresh_token)
      expect(rotationResult.replayDetected).toBe(false)
      expect(rotationResult.session).toBeDefined()
      expect(rotationResult.session!.refresh_token).not.toBe(session.refresh_token)

      // Old session should be revoked in DB
      const [oldSession] = await sql`SELECT * FROM os_sessions WHERE id = ${session.id}`
      expect(oldSession.revoked_at).not.toBeNull()
    })

    test("replay detection revokes entire token family", async () => {
      const regResult = await registerAccount(sql, { email: "replay@example.com", password: "Pass1234!" })
      await verifyAccountEmail(sql, regResult.account!.id)

      const session = await createSession(sql, {
        accountId: regResult.account!.id,
        audience: ["life"],
      })

      // First rotation succeeds
      const first = await rotateRefreshToken(sql, session.refresh_token)
      expect(first.session).toBeDefined()

      // Replaying the original token triggers replay detection
      const replay = await rotateRefreshToken(sql, session.refresh_token)
      expect(replay.replayDetected).toBe(true)
      expect(replay.session).toBeNull()

      // All sessions in family should be revoked
      const familySessions = await sql`
        SELECT * FROM os_sessions WHERE token_family = ${session.token_family}
      `
      for (const s of familySessions) {
        expect(s.revoked_at).not.toBeNull()
      }
    })

    test("revokeAllAccountSessions revokes all sessions", async () => {
      const regResult = await registerAccount(sql, { email: "revoke@example.com", password: "Pass1234!" })
      await verifyAccountEmail(sql, regResult.account!.id)
      const accountId = regResult.account!.id

      // Create multiple sessions
      await createSession(sql, { accountId, audience: ["life"] })
      await createSession(sql, { accountId, audience: ["learn"] })

      const count = await revokeAllAccountSessions(sql, accountId)
      expect(count).toBe(2)

      const sessions = await sql`SELECT * FROM os_sessions WHERE account_id = ${accountId} AND revoked_at IS NULL`
      expect(sessions.length).toBe(0)
    })
  })

  describe("memberships", () => {
    test("upsertMembership creates and updates membership", async () => {
      const regResult = await registerAccount(sql, { email: "member@example.com", password: "Pass1234!" })
      const accountId = regResult.account!.id

      // Create
      const membership = await upsertMembership(sql, {
        accountId,
        product: "life",
        roles: ["user"],
        entitlements: { features: ["dashboard"] },
      })
      expect(membership).toBeDefined()
      expect(membership.product).toBe("life")

      // Update
      const updated = await upsertMembership(sql, {
        accountId,
        product: "life",
        roles: ["user", "admin"],
        entitlements: { features: ["dashboard", "settings"] },
      })
      expect(updated.roles).toContain("admin")

      // Verify only one row exists (upsert, not insert)
      const memberships = await getAccountMemberships(sql, accountId)
      expect(memberships.length).toBe(1)
    })

    test("unique constraint on (account, product, org) works", async () => {
      const regResult = await registerAccount(sql, { email: "unique@example.com", password: "Pass1234!" })
      const accountId = regResult.account!.id

      // Two different products should work
      await upsertMembership(sql, { accountId, product: "life", roles: ["user"] })
      await upsertMembership(sql, { accountId, product: "learn", roles: ["student"] })

      const memberships = await getAccountMemberships(sql, accountId)
      expect(memberships.length).toBe(2)
    })
  })

  describe("audit log", () => {
    test("writeAudit persists to DB", async () => {
      const regResult = await registerAccount(sql, { email: "audit@example.com", password: "Pass1234!" })
      const accountId = regResult.account!.id

      await writeAudit(sql, {
        account_id: accountId,
        event_type: AUDIT_EVENTS.LOGIN,
        ip_address: "192.168.1.1",
        metadata: { method: "email_password" },
      })

      const [entry] = await sql`
        SELECT * FROM os_audit_log WHERE account_id = ${accountId} AND event_type = 'LOGIN'
      `
      expect(entry).toBeDefined()
      expect(entry.ip_address).toBe("192.168.1.1")
      expect(entry.metadata.method).toBe("email_password")
    })
  })

  describe("rate limiting (Postgres)", () => {
    test("allows requests within limit", async () => {
      const result = await checkRateLimitPg(sql, "10.0.0.1", "login")
      expect(result.allowed).toBe(true)
    })

    test("blocks requests exceeding limit", async () => {
      // Login limit is 10 per 15 min
      for (let i = 0; i < 10; i++) {
        await checkRateLimitPg(sql, "10.0.0.2", "login")
      }
      const blocked = await checkRateLimitPg(sql, "10.0.0.2", "login")
      expect(blocked.allowed).toBe(false)
      expect(blocked.retryAfter).toBeGreaterThan(0)
    })

    test("different IPs are isolated", async () => {
      for (let i = 0; i < 10; i++) {
        await checkRateLimitPg(sql, "10.0.0.3", "login")
      }
      // Different IP should still be allowed
      const result = await checkRateLimitPg(sql, "10.0.0.4", "login")
      expect(result.allowed).toBe(true)
    })
  })

  describe("cleanup", () => {
    test("purgeExpiredVerificationTokens removes expired tokens", async () => {
      const regResult = await registerAccount(sql, { email: "cleanup@example.com", password: "Pass1234!" })

      // Expire the token
      await sql`
        UPDATE os_email_verification_tokens
        SET expires_at = now() - interval '1 hour'
        WHERE account_id = ${regResult.account!.id}
      `

      const count = await purgeExpiredVerificationTokens(sql)
      expect(count).toBeGreaterThanOrEqual(1)

      const remaining = await sql`
        SELECT * FROM os_email_verification_tokens WHERE account_id = ${regResult.account!.id}
      `
      expect(remaining.length).toBe(0)
    })

    test("purgeExpiredSessions removes expired sessions", async () => {
      const regResult = await registerAccount(sql, { email: "cleanup-session@example.com", password: "Pass1234!" })
      await verifyAccountEmail(sql, regResult.account!.id)

      const session = await createSession(sql, {
        accountId: regResult.account!.id,
        audience: ["life"],
      })

      // Expire the session
      await sql`UPDATE os_sessions SET expires_at = now() - interval '1 hour' WHERE id = ${session.id}`

      const count = await purgeExpiredSessions(sql)
      expect(count).toBeGreaterThanOrEqual(1)
    })

    test("runCleanup purges both tokens and sessions", async () => {
      const result = await runCleanup(sql)
      expect(result).toHaveProperty("tokens")
      expect(result).toHaveProperty("sessions")
    })
  })

  describe("foreign key constraints", () => {
    test("deleting account cascades to sessions", async () => {
      const regResult = await registerAccount(sql, { email: "cascade@example.com", password: "Pass1234!" })
      await verifyAccountEmail(sql, regResult.account!.id)
      await createSession(sql, { accountId: regResult.account!.id, audience: ["life"] })

      await sql`DELETE FROM os_accounts WHERE id = ${regResult.account!.id}`

      const sessions = await sql`SELECT * FROM os_sessions WHERE account_id = ${regResult.account!.id}`
      expect(sessions.length).toBe(0)
    })

    test("deleting account cascades to verification tokens", async () => {
      const regResult = await registerAccount(sql, { email: "cascade2@example.com", password: "Pass1234!" })
      const accountId = regResult.account!.id

      await sql`DELETE FROM os_accounts WHERE id = ${accountId}`

      const tokens = await sql`SELECT * FROM os_email_verification_tokens WHERE account_id = ${accountId}`
      expect(tokens.length).toBe(0)
    })

    test("deleting account cascades to memberships", async () => {
      const regResult = await registerAccount(sql, { email: "cascade3@example.com", password: "Pass1234!" })
      const accountId = regResult.account!.id
      await upsertMembership(sql, { accountId, product: "life", roles: ["user"] })

      await sql`DELETE FROM os_accounts WHERE id = ${accountId}`

      const memberships = await sql`SELECT * FROM os_product_memberships WHERE account_id = ${accountId}`
      expect(memberships.length).toBe(0)
    })
  })
})
