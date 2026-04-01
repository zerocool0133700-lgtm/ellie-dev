import { describe, test, expect, mock } from "bun:test"
import { validateRegistrationInput, registerAccount } from "../src/os-auth/registration"

// ── Helpers ──────────────────────────────────────────────────

function makeFakeAccount(overrides?: Partial<{ id: string; email: string }>) {
  return {
    id: overrides?.id ?? "acc-123",
    email: overrides?.email ?? "dave@example.com",
    display_name: null,
    entity_type: "user",
    status: "pending_verification",
    email_verified: false,
    password_hash: "hashed",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
}

/**
 * Build a minimal postgres.js-style sql mock.
 *
 * `sql` is a tagged-template function that returns rows.
 * `sql.begin(cb)` calls cb(tx) where tx is another sql mock.
 * Both support chaining so callers get an array back.
 */
function makeSqlMock(opts: {
  accountRows?: object[]
  authMethodRows?: object[]
  beginError?: Error
  innerError?: Error
}) {
  const { accountRows = [], authMethodRows = [], beginError, innerError } = opts

  // Inner tx mock used inside sql.begin callback
  const txMock = (() => {
    let callCount = 0
    const fn = mock(async (_strings: TemplateStringsArray, ..._values: unknown[]) => {
      const call = callCount++
      if (innerError && call > 0) throw innerError
      return call === 0 ? accountRows : authMethodRows
    }) as any
    return fn
  })()

  // Outer sql mock
  const sqlMock = mock(async (_strings: TemplateStringsArray, ..._values: unknown[]) => {
    // Outer sql template calls (e.g. writeAudit) — return empty array
    return []
  }) as any

  sqlMock.begin = mock(async (cb: (tx: typeof txMock) => Promise<unknown>) => {
    if (beginError) throw beginError
    return cb(txMock)
  })

  return { sqlMock, txMock }
}

describe("os-auth registration — input validation", () => {
  test("rejects missing email", () => {
    const result = validateRegistrationInput({ password: "secure-pass-123" })
    expect(result.valid).toBe(false)
    expect(result.error).toBe("Email is required")
  })

  test("rejects invalid email", () => {
    const result = validateRegistrationInput({ email: "not-an-email", password: "secure-pass-123" })
    expect(result.valid).toBe(false)
    expect(result.error).toBe("Invalid email format")
  })

  test("rejects missing password", () => {
    const result = validateRegistrationInput({ email: "dave@example.com" })
    expect(result.valid).toBe(false)
    expect(result.error).toBe("Password is required")
  })

  test("rejects short password (under 8 chars)", () => {
    const result = validateRegistrationInput({ email: "dave@example.com", password: "short" })
    expect(result.valid).toBe(false)
    expect(result.error).toBe("Password must be at least 8 characters")
  })

  test("rejects password exceeding 128 characters", () => {
    const result = validateRegistrationInput({ email: "dave@example.com", password: "a".repeat(129) })
    expect(result.valid).toBe(false)
    expect(result.error).toBe("Password must be no more than 128 characters")
  })

  test("accepts password at exactly 128 characters", () => {
    const result = validateRegistrationInput({ email: "dave@example.com", password: "a".repeat(128) })
    expect(result.valid).toBe(true)
  })

  test("accepts valid input", () => {
    const result = validateRegistrationInput({
      email: "dave@example.com",
      password: "secure-password-123",
      display_name: "Dave",
    })
    expect(result.valid).toBe(true)
    expect(result.error).toBeUndefined()
    expect(result.email).toBe("dave@example.com")
    expect(result.display_name).toBe("Dave")
  })

  test("defaults entity_type to 'user' when omitted", () => {
    const result = validateRegistrationInput({
      email: "dave@example.com",
      password: "secure-password-123",
    })
    expect(result.valid).toBe(true)
    expect(result.entity_type).toBe("user")
  })

  test("accepts valid entity_type 'minor'", () => {
    const result = validateRegistrationInput({
      email: "kid@example.com",
      password: "secure-password-123",
      entity_type: "minor",
    })
    expect(result.valid).toBe(true)
    expect(result.entity_type).toBe("minor")
  })

  test("accepts valid entity_type 'org_service_account'", () => {
    const result = validateRegistrationInput({
      email: "svc@example.com",
      password: "secure-password-123",
      entity_type: "org_service_account",
    })
    expect(result.valid).toBe(true)
    expect(result.entity_type).toBe("org_service_account")
  })

  test("rejects invalid entity_type", () => {
    const result = validateRegistrationInput({
      email: "dave@example.com",
      password: "secure-password-123",
      entity_type: "admin",
    })
    expect(result.valid).toBe(false)
    expect(result.error).toContain("Invalid entity_type")
  })

  test("rejects non-string entity_type", () => {
    const result = validateRegistrationInput({
      email: "dave@example.com",
      password: "secure-password-123",
      entity_type: 42,
    })
    expect(result.valid).toBe(false)
    expect(result.error).toContain("Invalid entity_type")
  })

  test("normalizes email to lowercase", () => {
    const result = validateRegistrationInput({
      email: "Dave@Example.COM",
      password: "secure-password-123",
    })
    expect(result.valid).toBe(true)
    expect(result.email).toBe("dave@example.com")
  })
})

// ── registerAccount — DB transaction behavior ─────────────────

describe("os-auth registration — registerAccount", () => {
  test("calls sql.begin for the DB inserts", async () => {
    const fakeAccount = makeFakeAccount()
    const { sqlMock } = makeSqlMock({ accountRows: [fakeAccount] })

    const result = await registerAccount(
      sqlMock,
      { email: "dave@example.com", password: "secure-password-123" },
    )

    expect(result.ok).toBe(true)
    expect(sqlMock.begin).toHaveBeenCalledTimes(1)
  })

  test("returns the created account on success", async () => {
    const fakeAccount = makeFakeAccount({ email: "dave@example.com" })
    const { sqlMock } = makeSqlMock({ accountRows: [fakeAccount] })

    const result = await registerAccount(
      sqlMock,
      { email: "dave@example.com", password: "secure-password-123" },
    )

    expect(result.ok).toBe(true)
    expect(result.account?.email).toBe("dave@example.com")
    expect(result.account?.id).toBe("acc-123")
  })

  test("returns friendly error on duplicate email (23505)", async () => {
    const dupeError = Object.assign(new Error("duplicate key"), { code: "23505" })
    const { sqlMock } = makeSqlMock({ beginError: dupeError })

    const result = await registerAccount(
      sqlMock,
      { email: "existing@example.com", password: "secure-password-123" },
    )

    expect(result.ok).toBe(false)
    expect(result.error).toBe("An account with this email already exists")
  })

  test("rethrows non-duplicate DB errors", async () => {
    const dbError = Object.assign(new Error("connection lost"), { code: "08006" })
    const { sqlMock } = makeSqlMock({ beginError: dbError })

    await expect(
      registerAccount(sqlMock, { email: "dave@example.com", password: "secure-password-123" })
    ).rejects.toThrow("connection lost")
  })

  test("writeAudit (outer sql) is called AFTER the transaction resolves", async () => {
    const callOrder: string[] = []

    const fakeAccount = makeFakeAccount()
    const { sqlMock, txMock } = makeSqlMock({ accountRows: [fakeAccount] })

    // Instrument the begin mock to record when the transaction runs
    const originalBegin = sqlMock.begin
    sqlMock.begin = mock(async (cb: (tx: unknown) => Promise<unknown>) => {
      callOrder.push("begin")
      const result = await originalBegin(cb)
      callOrder.push("begin_done")
      return result
    })

    // Instrument the outer sql template to record when audit runs
    const wrappedSql = mock(async (...args: unknown[]) => {
      callOrder.push("outer_sql")
      return []
    }) as any
    wrappedSql.begin = sqlMock.begin

    await registerAccount(wrappedSql, { email: "dave@example.com", password: "secure-password-123" })

    // Transaction must complete before the outer sql (audit) is called
    const beginDoneIdx = callOrder.indexOf("begin_done")
    const outerSqlIdx = callOrder.indexOf("outer_sql")
    expect(beginDoneIdx).toBeGreaterThanOrEqual(0)
    expect(outerSqlIdx).toBeGreaterThan(beginDoneIdx)
  })

  test("inner tx error during auth_method insert rolls back (23505 caught)", async () => {
    // Simulate os_accounts INSERT succeeding but os_auth_methods INSERT causing a unique violation
    const innerDupeError = Object.assign(new Error("duplicate key"), { code: "23505" })
    const fakeAccount = makeFakeAccount({ email: "dave@example.com" })
    const { sqlMock } = makeSqlMock({ accountRows: [fakeAccount], innerError: innerDupeError })

    const result = await registerAccount(
      sqlMock,
      { email: "dave@example.com", password: "secure-password-123" },
    )

    // The error bubbles out of sql.begin and is caught by the 23505 handler
    expect(result.ok).toBe(false)
    expect(result.error).toBe("An account with this email already exists")
  })
})
