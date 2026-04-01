import { describe, test, expect } from "bun:test"
import { validateRegistrationInput } from "../src/os-auth/registration"

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

  test("normalizes email to lowercase", () => {
    const result = validateRegistrationInput({
      email: "Dave@Example.COM",
      password: "secure-password-123",
    })
    expect(result.valid).toBe(true)
    expect(result.email).toBe("dave@example.com")
  })
})
