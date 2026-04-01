/**
 * Tests for /me endpoint audience query parameter (ELLIE-1243).
 *
 * Verifies that:
 *   - ?audience=<valid>  — verifies token against that audience only
 *   - ?audience=<invalid> — returns 400 immediately
 *   - no audience param  — existing behavior (try all audiences)
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { handleOsAuthRoute, _resetKeyCache } from "../src/os-auth/index"
import { signAccessToken } from "../src/os-auth/tokens"
import { generateKeyPair } from "../src/os-auth/keys"
import type { ApiRequest, ApiResponse } from "../src/api/types"

// ── Key pair shared across tests ────────────────────────────────
const keyPairPromise = generateKeyPair()

async function makeToken(audience: string): Promise<string> {
  const { privateKey } = await keyPairPromise
  return signAccessToken({
    privateKey,
    kid: "test-kid-me-audience",
    accountId: "acc-test-123",
    email: "dave@example.com",
    entityType: "user",
    audience,
    memberships: { [audience]: { roles: ["member"], entitlements: {} } },
  })
}

// ── Minimal mock helpers ─────────────────────────────────────────

function makeRes(): { status: number | null; body: unknown; res: ApiResponse } {
  const captured: { status: number | null; body: unknown } = { status: null, body: null }
  const res: ApiResponse = {
    status: (code: number) => ({
      json: (data: unknown) => {
        captured.status = code
        captured.body = data
      },
    }),
    json: (data: unknown) => {
      captured.status = 200
      captured.body = data
    },
    setHeader: () => {},
  } as any
  return { status: captured.status, body: captured.body, res }
}

/** Build deps with a key pair that matches the tokens we sign above. */
async function makeDeps() {
  const { privateKey, publicKey } = await keyPairPromise
  const kid = "test-kid-me-audience"

  return {
    sql: (() => {
      // Returns a canned account row for account lookups
      const fn = (_strings: TemplateStringsArray, ..._values: unknown[]) =>
        Promise.resolve([{
          id: "acc-test-123",
          email: "dave@example.com",
          display_name: "Dave",
          entity_type: "user",
          email_verified: true,
          status: "active",
        }])
      fn.begin = async (cb: (tx: any) => unknown) => cb(fn)
      return fn
    })() as any,

    retrieveSecret: async (_keychainId: string, key: string) => {
      if (key === "private_key") return privateKey
      if (key === "public_key") return publicKey
      if (key === "kid") return kid
      return null
    },
  }
}

function makeReq(token: string, headers?: Record<string, string>): ApiRequest & { headers: Record<string, string> } {
  return {
    body: {},
    headers: {
      authorization: `Bearer ${token}`,
      ...headers,
    },
  }
}

// ── Tests ────────────────────────────────────────────────────────

describe("/me endpoint — audience query parameter", () => {
  // Reset the global key cache before and after each test so our test key pair
  // is loaded fresh via retrieveSecret, not a leftover from another test file,
  // and so this file does not contaminate subsequent test files.
  beforeEach(() => _resetKeyCache())
  afterEach(() => _resetKeyCache())

  test("returns 400 for invalid audience parameter", async () => {
    const deps = await makeDeps()
    const token = await makeToken("life")
    const req = makeReq(token)
    const captured: { status: number | null; body: unknown } = { status: null, body: null }
    const res: ApiResponse = {
      status: (code: number) => ({
        json: (data: unknown) => { captured.status = code; captured.body = data },
      }),
      json: (data: unknown) => { captured.status = 200; captured.body = data },
      setHeader: () => {},
    } as any

    const query = new URLSearchParams({ audience: "bogus" })
    await handleOsAuthRoute(req, res, "/api/os-auth/me", "GET", deps, query)

    expect(captured.status).toBe(400)
    expect((captured.body as any).error).toMatch(/invalid audience/i)
  })

  test("returns 400 for empty string audience parameter", async () => {
    const deps = await makeDeps()
    const token = await makeToken("life")
    const req = makeReq(token)
    const captured: { status: number | null; body: unknown } = { status: null, body: null }
    const res: ApiResponse = {
      status: (code: number) => ({
        json: (data: unknown) => { captured.status = code; captured.body = data },
      }),
      json: (data: unknown) => { captured.status = 200; captured.body = data },
      setHeader: () => {},
    } as any

    const query = new URLSearchParams({ audience: "" })
    await handleOsAuthRoute(req, res, "/api/os-auth/me", "GET", deps, query)

    expect(captured.status).toBe(400)
    expect((captured.body as any).error).toMatch(/invalid audience/i)
  })

  test("accepts token when audience param matches token audience", async () => {
    const deps = await makeDeps()
    const token = await makeToken("life")
    const req = makeReq(token)
    const captured: { status: number | null; body: unknown } = { status: null, body: null }
    const res: ApiResponse = {
      status: (code: number) => ({
        json: (data: unknown) => { captured.status = code; captured.body = data },
      }),
      json: (data: unknown) => { captured.status = 200; captured.body = data },
      setHeader: () => {},
    } as any

    const query = new URLSearchParams({ audience: "life" })
    await handleOsAuthRoute(req, res, "/api/os-auth/me", "GET", deps, query)

    expect(captured.status).toBe(200)
    expect((captured.body as any).ok).toBe(true)
    expect((captured.body as any).account.email).toBe("dave@example.com")
  })

  test("rejects token when audience param does not match token audience", async () => {
    const deps = await makeDeps()
    // Token is signed for "life" but we request "learn"
    const token = await makeToken("life")
    const req = makeReq(token)
    const captured: { status: number | null; body: unknown } = { status: null, body: null }
    const res: ApiResponse = {
      status: (code: number) => ({
        json: (data: unknown) => { captured.status = code; captured.body = data },
      }),
      json: (data: unknown) => { captured.status = 200; captured.body = data },
      setHeader: () => {},
    } as any

    const query = new URLSearchParams({ audience: "learn" })
    await handleOsAuthRoute(req, res, "/api/os-auth/me", "GET", deps, query)

    expect(captured.status).toBe(401)
    expect((captured.body as any).error).toMatch(/invalid or expired token/i)
  })

  test("accepts learn token when audience param is 'learn'", async () => {
    const deps = await makeDeps()
    const token = await makeToken("learn")
    const req = makeReq(token)
    const captured: { status: number | null; body: unknown } = { status: null, body: null }
    const res: ApiResponse = {
      status: (code: number) => ({
        json: (data: unknown) => { captured.status = code; captured.body = data },
      }),
      json: (data: unknown) => { captured.status = 200; captured.body = data },
      setHeader: () => {},
    } as any

    const query = new URLSearchParams({ audience: "learn" })
    await handleOsAuthRoute(req, res, "/api/os-auth/me", "GET", deps, query)

    expect(captured.status).toBe(200)
    expect((captured.body as any).ok).toBe(true)
  })

  test("no audience param — accepts any valid audience (life token)", async () => {
    const deps = await makeDeps()
    const token = await makeToken("life")
    const req = makeReq(token)
    const captured: { status: number | null; body: unknown } = { status: null, body: null }
    const res: ApiResponse = {
      status: (code: number) => ({
        json: (data: unknown) => { captured.status = code; captured.body = data },
      }),
      json: (data: unknown) => { captured.status = 200; captured.body = data },
      setHeader: () => {},
    } as any

    // No query params — should try all audiences
    await handleOsAuthRoute(req, res, "/api/os-auth/me", "GET", deps)

    expect(captured.status).toBe(200)
    expect((captured.body as any).ok).toBe(true)
  })

  test("no audience param — accepts any valid audience (learn token)", async () => {
    const deps = await makeDeps()
    const token = await makeToken("learn")
    const req = makeReq(token)
    const captured: { status: number | null; body: unknown } = { status: null, body: null }
    const res: ApiResponse = {
      status: (code: number) => ({
        json: (data: unknown) => { captured.status = code; captured.body = data },
      }),
      json: (data: unknown) => { captured.status = 200; captured.body = data },
      setHeader: () => {},
    } as any

    await handleOsAuthRoute(req, res, "/api/os-auth/me", "GET", deps)

    expect(captured.status).toBe(200)
    expect((captured.body as any).ok).toBe(true)
  })

  test("no audience param — rejects missing auth header regardless", async () => {
    const deps = await makeDeps()
    const req: ApiRequest & { headers: Record<string, string> } = { body: {}, headers: {} }
    const captured: { status: number | null; body: unknown } = { status: null, body: null }
    const res: ApiResponse = {
      status: (code: number) => ({
        json: (data: unknown) => { captured.status = code; captured.body = data },
      }),
      json: (data: unknown) => { captured.status = 200; captured.body = data },
      setHeader: () => {},
    } as any

    await handleOsAuthRoute(req, res, "/api/os-auth/me", "GET", deps)

    expect(captured.status).toBe(401)
    expect((captured.body as any).error).toBe("Missing Authorization header")
  })
})
