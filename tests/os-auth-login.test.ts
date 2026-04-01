import { describe, test, expect, mock } from "bun:test"

// Mock dependencies before importing loginWithPassword
mock.module("../src/os-auth/passwords", () => ({
  verifyPassword: async () => true,
}))
mock.module("../src/os-auth/tokens", () => ({
  signAccessToken: async () => "mock-access-token",
  generateRefreshToken: () => "mock-refresh-token",
}))
mock.module("../src/os-auth/sessions", () => ({
  createSession: async () => {},
}))
mock.module("../src/os-auth/audit", () => ({
  writeAudit: async () => {},
  AUDIT_EVENTS: { LOGIN: "login", LOGIN_FAILED: "login_failed" },
}))

import { validateLoginInput, loginWithPassword } from "../src/os-auth/login"

// Minimal tagged-template SQL mock that returns canned rows
function mockSql(rows: unknown[]) {
  const fn = (_strings: TemplateStringsArray, ..._values: unknown[]) => rows
  return fn as any
}

const signingKeys = { privateKey: "mock-key", kid: "mock-kid" }

describe("os-auth login — input validation", () => {
  test("rejects missing email", () => {
    const result = validateLoginInput({ password: "pass" })
    expect(result.valid).toBe(false)
    expect(result.error).toBe("Email is required")
  })

  test("rejects missing password", () => {
    const result = validateLoginInput({ email: "dave@example.com" })
    expect(result.valid).toBe(false)
    expect(result.error).toBe("Password is required")
  })

  test("rejects password exceeding 128 characters", () => {
    const result = validateLoginInput({ email: "dave@example.com", password: "a".repeat(129) })
    expect(result.valid).toBe(false)
    expect(result.error).toBe("Password must be no more than 128 characters")
  })

  test("accepts valid credentials", () => {
    const result = validateLoginInput({ email: "Dave@Example.COM", password: "password123" })
    expect(result.valid).toBe(true)
    expect(result.email).toBe("dave@example.com")
  })
})

describe("os-auth login — account status guards", () => {
  test("rejects pending_verification accounts", async () => {
    const sql = mockSql([{
      id: "acc-1",
      email: "unverified@example.com",
      status: "pending_verification",
      password_hash: "$argon2id$fake",
      display_name: "Unverified",
      entity_type: "human",
    }])

    const result = await loginWithPassword(
      sql,
      { email: "unverified@example.com", password: "password123", audience: "life" },
      signingKeys,
    )

    expect(result.ok).toBe(false)
    expect(result.error).toBe("Please verify your email before signing in")
  })

  test("rejects suspended accounts", async () => {
    const sql = mockSql([{
      id: "acc-2",
      email: "suspended@example.com",
      status: "suspended",
      password_hash: "$argon2id$fake",
      display_name: "Suspended",
      entity_type: "human",
    }])

    const result = await loginWithPassword(
      sql,
      { email: "suspended@example.com", password: "password123", audience: "life" },
      signingKeys,
    )

    expect(result.ok).toBe(false)
    expect(result.error).toBe("Account is suspended")
  })

  test("returns not found for deleted accounts", async () => {
    const sql = mockSql([])

    const result = await loginWithPassword(
      sql,
      { email: "deleted@example.com", password: "password123", audience: "life" },
      signingKeys,
    )

    expect(result.ok).toBe(false)
    expect(result.error).toBe("Invalid email or password")
  })
})
