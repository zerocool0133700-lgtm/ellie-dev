import { describe, test, expect } from "bun:test"
import { hashPassword, verifyPassword } from "../src/os-auth/passwords"

describe("os-auth passwords", () => {
  test("hashPassword returns a string starting with $argon2id$", async () => {
    const hash = await hashPassword("test-password-123")
    expect(hash.startsWith("$argon2id$")).toBe(true)
  })

  test("verifyPassword returns true for correct password", async () => {
    const hash = await hashPassword("correct-horse-battery-staple")
    const result = await verifyPassword("correct-horse-battery-staple", hash)
    expect(result).toBe(true)
  })

  test("verifyPassword returns false for wrong password", async () => {
    const hash = await hashPassword("correct-horse-battery-staple")
    const result = await verifyPassword("wrong-password", hash)
    expect(result).toBe(false)
  })

  test("same password produces different hashes (salt)", async () => {
    const hash1 = await hashPassword("same-password")
    const hash2 = await hashPassword("same-password")
    expect(hash1).not.toBe(hash2)
  })
})
