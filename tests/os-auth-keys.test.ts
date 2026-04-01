import { describe, test, expect } from "bun:test"
import {
  generateKeyPair,
  publicKeyToJwk,
  buildJwksResponse,
} from "../src/os-auth/keys"

describe("os-auth keys", () => {
  test("generateKeyPair returns PEM-encoded RSA key pair", async () => {
    const { publicKey, privateKey } = await generateKeyPair()
    expect(publicKey).toContain("-----BEGIN PUBLIC KEY-----")
    expect(privateKey).toContain("-----BEGIN PRIVATE KEY-----")
  })

  test("publicKeyToJwk converts PEM to JWK format", async () => {
    const { publicKey } = await generateKeyPair()
    const jwk = publicKeyToJwk(publicKey, "test-kid-1")
    expect(jwk.kty).toBe("RSA")
    expect(jwk.alg).toBe("RS256")
    expect(jwk.use).toBe("sig")
    expect(jwk.kid).toBe("test-kid-1")
    expect(jwk.n).toBeDefined()
    expect(jwk.e).toBeDefined()
  })

  test("buildJwksResponse wraps JWK in standard JWKS format", async () => {
    const { publicKey } = await generateKeyPair()
    const jwk = publicKeyToJwk(publicKey, "kid-1")
    const jwks = buildJwksResponse([jwk])
    expect(jwks.keys).toHaveLength(1)
    expect(jwks.keys[0].kid).toBe("kid-1")
  })
})
