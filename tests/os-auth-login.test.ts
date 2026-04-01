import { describe, test, expect } from "bun:test"
import { validateLoginInput } from "../src/os-auth/login"

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

  test("accepts valid credentials", () => {
    const result = validateLoginInput({ email: "Dave@Example.COM", password: "password123" })
    expect(result.valid).toBe(true)
    expect(result.email).toBe("dave@example.com")
  })
})
