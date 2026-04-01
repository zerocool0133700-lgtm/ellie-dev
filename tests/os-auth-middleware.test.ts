import { describe, test, expect } from "bun:test"
import { authenticateOsRequest } from "../src/os-auth/middleware"
import { signAccessToken } from "../src/os-auth/tokens"
import { generateKeyPair } from "../src/os-auth/keys"

describe("authenticateOsRequest", () => {
  let privateKey: string
  let publicKey: string
  const kid = "test-kid-middleware"

  const keyPairPromise = generateKeyPair()

  async function makeToken(opts: {
    audience?: string
    accountId?: string
    email?: string
    entityType?: "user" | "minor" | "org_service_account"
    memberships?: Record<string, { roles: string[]; entitlements: Record<string, unknown> }>
    expiresInSeconds?: number
  } = {}) {
    const { privateKey: pk, publicKey: pub } = await keyPairPromise
    privateKey = pk
    publicKey = pub
    return signAccessToken({
      privateKey,
      kid,
      accountId: opts.accountId ?? "acc-123",
      email: opts.email ?? "dave@example.com",
      entityType: opts.entityType ?? "user",
      audience: opts.audience ?? "life",
      memberships: opts.memberships ?? { life: { roles: ["member"], entitlements: {} } },
      expiresInSeconds: opts.expiresInSeconds,
    })
  }

  async function getPublicKey() {
    const { publicKey: pub } = await keyPairPromise
    return pub
  }

  test("returns payload for valid Bearer token", async () => {
    const token = await makeToken()
    const pub = await getPublicKey()

    const result = authenticateOsRequest(
      { authorization: `Bearer ${token}` },
      pub,
    )

    expect(result.ok).toBe(true)
    expect(result.payload!.sub).toBe("acc-123")
    expect(result.payload!.email).toBe("dave@example.com")
    expect(result.payload!.aud).toBe("life")
  })

  test("returns payload for 'learn' audience token", async () => {
    const token = await makeToken({ audience: "learn" })
    const pub = await getPublicKey()

    const result = authenticateOsRequest(
      { authorization: `Bearer ${token}` },
      pub,
    )

    expect(result.ok).toBe(true)
    expect(result.payload!.aud).toBe("learn")
  })

  test("returns error when Authorization header is missing", async () => {
    const pub = await getPublicKey()

    const result = authenticateOsRequest({}, pub)

    expect(result.ok).toBe(false)
    expect(result.status).toBe(401)
    expect(result.error).toBe("Missing Authorization header")
  })

  test("returns error when Authorization header is not Bearer", async () => {
    const pub = await getPublicKey()

    const result = authenticateOsRequest(
      { authorization: "Basic abc123" },
      pub,
    )

    expect(result.ok).toBe(false)
    expect(result.status).toBe(401)
    expect(result.error).toBe("Missing Authorization header")
  })

  test("returns error for expired token", async () => {
    const token = await makeToken({ expiresInSeconds: -10 })
    const pub = await getPublicKey()

    const result = authenticateOsRequest(
      { authorization: `Bearer ${token}` },
      pub,
    )

    expect(result.ok).toBe(false)
    expect(result.status).toBe(401)
    expect(result.error).toBe("Invalid or expired token")
  })

  test("returns error for malformed token", async () => {
    const pub = await getPublicKey()

    const result = authenticateOsRequest(
      { authorization: "Bearer not.a.real.token" },
      pub,
    )

    expect(result.ok).toBe(false)
    expect(result.status).toBe(401)
    expect(result.error).toBe("Invalid or expired token")
  })

  test("returns error for token signed with different key", async () => {
    const { privateKey: otherPrivate } = await generateKeyPair()
    const token = await signAccessToken({
      privateKey: otherPrivate,
      kid: "other-kid",
      accountId: "acc-123",
      email: "dave@example.com",
      entityType: "user",
      audience: "life",
      memberships: {},
    })
    const pub = await getPublicKey()

    const result = authenticateOsRequest(
      { authorization: `Bearer ${token}` },
      pub,
    )

    expect(result.ok).toBe(false)
    expect(result.status).toBe(401)
    expect(result.error).toBe("Invalid or expired token")
  })

  test("accepts specific audience when provided", async () => {
    const token = await makeToken({ audience: "life" })
    const pub = await getPublicKey()

    const result = authenticateOsRequest(
      { authorization: `Bearer ${token}` },
      pub,
      { audience: "life" },
    )

    expect(result.ok).toBe(true)
    expect(result.payload!.aud).toBe("life")
  })

  test("rejects token when audience does not match requested audience", async () => {
    const token = await makeToken({ audience: "life" })
    const pub = await getPublicKey()

    const result = authenticateOsRequest(
      { authorization: `Bearer ${token}` },
      pub,
      { audience: "learn" },
    )

    expect(result.ok).toBe(false)
    expect(result.status).toBe(401)
    expect(result.error).toBe("Invalid or expired token")
  })
})
