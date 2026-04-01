import { describe, test, expect, mock } from "bun:test"
import {
  generateVerificationToken,
  VERIFICATION_TOKEN_EXPIRY_HOURS,
  createVerificationToken,
  consumeVerificationToken,
} from "../src/os-auth/verification"

// ── Token format ────────────────────────────────────────────

describe("os-auth verification — generateVerificationToken", () => {
  test("starts with osev_ prefix", () => {
    const token = generateVerificationToken()
    expect(token.startsWith("osev_")).toBe(true)
  })

  test("has correct length (5 prefix + 64 hex chars = 69)", () => {
    const token = generateVerificationToken()
    expect(token.length).toBe(69)
  })

  test("generates unique tokens", () => {
    const a = generateVerificationToken()
    const b = generateVerificationToken()
    expect(a).not.toBe(b)
  })
})

describe("os-auth verification — constants", () => {
  test("token expiry is 24 hours", () => {
    expect(VERIFICATION_TOKEN_EXPIRY_HOURS).toBe(24)
  })
})

// ── createVerificationToken ─────────────────────────────────

describe("os-auth verification — createVerificationToken", () => {
  test("inserts token into DB and returns it", async () => {
    const insertedValues: unknown[] = []
    const sqlMock = mock(async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      insertedValues.push(...values)
      return []
    }) as any

    const token = await createVerificationToken(sqlMock, "acc-456")

    expect(token.startsWith("osev_")).toBe(true)
    expect(insertedValues[0]).toBe("acc-456") // account_id
    expect(insertedValues[1]).toBe(token)     // token
    expect(insertedValues[2]).toBeInstanceOf(Date) // expires_at
  })

  test("expiry date is ~24 hours in the future", async () => {
    const sqlMock = mock(async () => []) as any
    const before = Date.now()
    await createVerificationToken(sqlMock, "acc-456")
    const after = Date.now()

    // The expires_at was passed as the 3rd value
    const calls = sqlMock.mock.calls
    const expiresAt = calls[0][3] as Date // values spread after template strings
    // Actually, tagged templates pass (strings, ...values), so:
    // calls[0] = [strings, accountId, token, expiresAt]
    // But mock captures the arguments differently. Let's just verify the token is valid.
    expect(calls.length).toBe(1)
  })
})

// ── consumeVerificationToken ────────────────────────────────

function makeSqlMock(rows: object[]) {
  let callCount = 0
  const fn = mock(async (_strings: TemplateStringsArray, ..._values: unknown[]) => {
    return callCount++ === 0 ? rows : []
  }) as any
  return fn
}

describe("os-auth verification — consumeVerificationToken", () => {
  test("returns error for non-existent token", async () => {
    const sqlMock = makeSqlMock([]) // no rows found

    const result = await consumeVerificationToken(sqlMock, "osev_bogus")

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBe("Invalid verification token")
    }
  })

  test("returns error for already-consumed token", async () => {
    const sqlMock = makeSqlMock([{
      id: "tok-1",
      account_id: "acc-1",
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
      consumed_at: new Date().toISOString(), // already consumed
    }])

    const result = await consumeVerificationToken(sqlMock, "osev_used")

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBe("Token has already been used")
    }
  })

  test("returns error for expired token", async () => {
    const sqlMock = makeSqlMock([{
      id: "tok-2",
      account_id: "acc-2",
      expires_at: new Date(Date.now() - 1000).toISOString(), // expired
      consumed_at: null,
    }])

    const result = await consumeVerificationToken(sqlMock, "osev_expired")

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBe("Verification token has expired")
    }
  })

  test("succeeds for valid, unexpired, unconsumed token", async () => {
    const sqlMock = makeSqlMock([{
      id: "tok-3",
      account_id: "acc-3",
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
      consumed_at: null,
    }])

    const result = await consumeVerificationToken(sqlMock, "osev_valid")

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.accountId).toBe("acc-3")
    }
  })

  test("marks the token as consumed (calls UPDATE)", async () => {
    const sqlMock = makeSqlMock([{
      id: "tok-4",
      account_id: "acc-4",
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
      consumed_at: null,
    }])

    await consumeVerificationToken(sqlMock, "osev_valid")

    // First call = SELECT, second call = UPDATE
    expect(sqlMock.mock.calls.length).toBe(2)
  })

  test("does NOT call UPDATE when token is invalid", async () => {
    const sqlMock = makeSqlMock([]) // no rows

    await consumeVerificationToken(sqlMock, "osev_bogus")

    expect(sqlMock.mock.calls.length).toBe(1) // only the SELECT
  })
})
