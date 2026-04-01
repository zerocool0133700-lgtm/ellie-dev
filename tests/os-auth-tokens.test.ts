import { describe, test, expect } from "bun:test"
import {
  signAccessToken,
  verifyAccessToken,
  generateRefreshToken,
  ACCESS_TOKEN_EXPIRY_SECONDS,
} from "../src/os-auth/tokens"
import { generateKeyPair } from "../src/os-auth/keys"

describe("os-auth tokens", () => {
  let privateKey: string
  let publicKey: string
  const kid = "test-kid-1"

  // Generate a key pair for all tests
  const keyPairPromise = generateKeyPair()

  test("signAccessToken creates a valid JWT", async () => {
    const { privateKey: pk, publicKey: pub } = await keyPairPromise
    privateKey = pk
    publicKey = pub

    const token = await signAccessToken({
      privateKey,
      kid,
      accountId: "acc-uuid-1",
      email: "dave@example.com",
      entityType: "user",
      audience: "life",
      memberships: {
        life: { roles: ["pro"], entitlements: { tier: "pro" } },
      },
    })

    expect(typeof token).toBe("string")
    expect(token.split(".")).toHaveLength(3) // header.payload.signature
  })

  test("verifyAccessToken decodes a valid token", async () => {
    const { privateKey: pk, publicKey: pub } = await keyPairPromise
    privateKey = pk
    publicKey = pub

    const token = await signAccessToken({
      privateKey,
      kid,
      accountId: "acc-uuid-1",
      email: "dave@example.com",
      entityType: "user",
      audience: "life",
      memberships: {
        life: { roles: ["pro"], entitlements: { tier: "pro" } },
      },
    })

    const payload = verifyAccessToken(token, publicKey, "life")
    expect(payload).not.toBeNull()
    expect(payload!.sub).toBe("acc-uuid-1")
    expect(payload!.aud).toBe("life")
    expect(payload!.iss).toBe("ellie-os")
    expect(payload!.email).toBe("dave@example.com")
    expect(payload!.memberships.life.roles).toEqual(["pro"])
  })

  test("verifyAccessToken rejects token with wrong audience", async () => {
    const { privateKey: pk, publicKey: pub } = await keyPairPromise
    privateKey = pk
    publicKey = pub

    const token = await signAccessToken({
      privateKey,
      kid,
      accountId: "acc-uuid-1",
      email: "dave@example.com",
      entityType: "user",
      audience: "life",
      memberships: {},
    })

    const payload = verifyAccessToken(token, publicKey, "learn")
    expect(payload).toBeNull()
  })

  test("verifyAccessToken rejects expired token", async () => {
    const { privateKey: pk, publicKey: pub } = await keyPairPromise
    privateKey = pk
    publicKey = pub

    const token = await signAccessToken({
      privateKey,
      kid,
      accountId: "acc-uuid-1",
      email: "dave@example.com",
      entityType: "user",
      audience: "life",
      memberships: {},
      expiresInSeconds: -10, // already expired
    })

    const payload = verifyAccessToken(token, publicKey, "life")
    expect(payload).toBeNull()
  })

  test("generateRefreshToken returns a 64-char hex string prefixed with osrt_", () => {
    const token = generateRefreshToken()
    expect(token.startsWith("osrt_")).toBe(true)
    expect(token.length).toBe(5 + 64) // "osrt_" + 32 bytes hex
  })

  test("ACCESS_TOKEN_EXPIRY_SECONDS is 900 (15 minutes)", () => {
    expect(ACCESS_TOKEN_EXPIRY_SECONDS).toBe(900)
  })
})
