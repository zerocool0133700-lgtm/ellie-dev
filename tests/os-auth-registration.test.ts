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
