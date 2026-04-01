import { describe, test, expect } from "bun:test"
import {
  buildNewSession,
  isSessionExpired,
  isSessionRevoked,
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
